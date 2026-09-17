import type { LlmRetryState } from '../../../lib/api/sessionLive'
import { RetryIndicator } from './RetryIndicator'
import { memo, useDeferredValue, useEffect, useRef } from 'react'
import type { AgentRunStep } from '../../../lib/api/agentRuntime'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { ThinkingIndicator } from './ThinkingIndicator'
import { ToolCallRoundPanel } from './ToolCallRoundPanel'
import type { TurnContentBlock } from './buildInterleavedTurns'
import { buildTurnRenderSegments } from './toolCallUtils'
import { materializeLiveBlocks, type StreamingLiveBuffers } from './streamingLiveBlocks'

function renderLiveSegments(blocks: TurnContentBlock[], isStreaming: boolean, rowKeyPrefix = '') {
  const segments = buildTurnRenderSegments(blocks)
  const toolBlocks = segments.flatMap(segment => segment.type === 'tool_round' ? segment.toolBlocks : [])
  const answers = segments.filter(segment => segment.type !== 'tool_round')
  const render = (segment: (typeof segments)[number], i: number) => {
    const live = isStreaming && segment === segments[segments.length - 1]
    if (segment.type === 'thinking') return <ThinkingBlock key={i} content={segment.content} isStreaming={live} rememberKey={rowKeyPrefix ? `${rowKeyPrefix}:${i}` : undefined} />
    if (segment.type === 'tool_round') return <ToolCallRoundPanel key={i} toolBlocks={segment.toolBlocks} />
    if (segment.type === 'text') return <StreamingTextBlock key={i} text={segment.content} isStreaming={live} markdown={segment.markdown && !live} />
    return null
  }
  return <><div className="session-tool-region">{toolBlocks.length > 0 && <ToolCallRoundPanel toolBlocks={toolBlocks} maxHeight="none" isStreaming={isStreaming} />}</div><div className="session-answer-region">{answers.map(render)}</div></>
}
const CompletedStepView = memo(function CompletedStepView({
  blocks,
  stepId,
}: {
  blocks: TurnContentBlock[]
  stepId: string
}) {
  if (blocks.length === 0) return null
  return (
    <div className="session-completed-step animate-[fade-up_0.3s_ease-out]">
      <div className="session-turn-content flex min-w-0 flex-1 flex-col gap-1">
        {renderLiveSegments(blocks, false, stepId)}
      </div>
    </div>
  )
})

const LiveStepView = memo(function LiveStepView({
  streamingLive,
  retry,
}: {
  retry?: LlmRetryState | null
  streamingLive: StreamingLiveBuffers
}) {
  const deferredLive = useDeferredValue(streamingLive)
  const blocks = materializeLiveBlocks(deferredLive)
  const hasContent = blocks.length > 0

  return (
    <div className="session-turn-content flex min-w-0 flex-1 flex-col gap-1">
      {hasContent ? renderLiveSegments(blocks, true) : !retry ? <ThinkingIndicator /> : null}
      {retry && <RetryIndicator retry={retry} />}
    </div>
  )
})

interface Props {
  steps: AgentRunStep[]
  retry?: LlmRetryState | null
  streamingStepId: string | null
  streamingLive: StreamingLiveBuffers
  streamingCompletedSteps: Array<{
    stepId: string
    stepIndex: number
    blocks: TurnContentBlock[]
  }>
  scrollContainerRef?: React.RefObject<HTMLElement | null>
}

export const SessionLiveTurn = memo(function SessionLiveTurn({
  steps,
  streamingStepId,
  retry,
  streamingLive,
  streamingCompletedSteps,
  scrollContainerRef,
}: Props) {
  const isNearBottom = useRef(true)

  const streamingStep = streamingStepId ? steps.find(step => step.id === streamingStepId) : undefined
  const showLiveBlock = Boolean(streamingStepId) && (!streamingStep || streamingStep.status === 'running')

  // History owns persisted steps; snapshots bridge the gap until detail refresh.
  const persistedStepIds = new Set(steps.map(step => step.id))
  const pendingCompletedSteps = streamingCompletedSteps.filter(step => !persistedStepIds.has(step.stepId))

  useEffect(() => {
    const el = scrollContainerRef?.current
    if (!el) return
    const onScroll = () => {
      isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollContainerRef])

  useEffect(() => {
    const el = scrollContainerRef?.current
    if (isNearBottom.current && el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }, [scrollContainerRef, streamingLive, streamingCompletedSteps.length])

  if (!showLiveBlock && pendingCompletedSteps.length === 0) {
    return null
  }

  return (
    <>
      {pendingCompletedSteps.map(step => (
        <CompletedStepView
          key={step.stepId}
          blocks={step.blocks}
          stepId={step.stepId}
        />
      ))}
      {showLiveBlock ? (
        <LiveStepView streamingLive={streamingLive} retry={retry} />
      ) : null}
    </>
  )
})
