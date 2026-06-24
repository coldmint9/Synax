import { memo, useDeferredValue, useEffect, useRef } from 'react'
import type { AgentRunStep, PermissionDecision } from '../../../lib/api/agentRuntime'
import { GoalQuickApproval, listPendingGoalPermissions } from '../wiki/goal/GoalQuickApproval'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { ThinkingIndicator } from './ThinkingIndicator'
import { ToolCallRoundPanel } from './ToolCallRoundPanel'
import type { TurnContentBlock } from './buildInterleavedTurns'
import { buildTurnRenderSegments } from './toolCallUtils'
import { materializeLiveBlocks, type StreamingLiveBuffers } from './streamingLiveBlocks'

function renderLiveSegments(
  blocks: TurnContentBlock[],
  isStreaming: boolean,
) {
  const segments = buildTurnRenderSegments(blocks)

  return segments.map((segment, i) => {
    const segmentIsLive = isStreaming && i === segments.length - 1
    if (segment.type === 'thinking') {
      return (
        <ThinkingBlock
          key={i}
          content={segment.content}
          isStreaming={segmentIsLive}
        />
      )
    }
    if (segment.type === 'tool_round') {
      return <ToolCallRoundPanel key={i} toolBlocks={segment.toolBlocks} />
    }
    if (segment.type === 'text') {
      return (
        <StreamingTextBlock
          key={i}
          text={segment.content}
          isStreaming={segmentIsLive}
          markdown={segment.markdown && !segmentIsLive}
        />
      )
    }
    return null
  })
}

const CompletedStepView = memo(function CompletedStepView({
  blocks,
}: {
  blocks: TurnContentBlock[]
}) {
  if (blocks.length === 0) return null
  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {renderLiveSegments(blocks, false)}
      </div>
    </div>
  )
})

const LiveStepView = memo(function LiveStepView({
  streamingLive,
}: {
  streamingLive: StreamingLiveBuffers
}) {
  const deferredLive = useDeferredValue(streamingLive)
  const blocks = materializeLiveBlocks(deferredLive)
  const hasContent = blocks.length > 0

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {hasContent ? renderLiveSegments(blocks, true) : <ThinkingIndicator />}
    </div>
  )
})

interface Props {
  steps: AgentRunStep[]
  streamingStepId: string | null
  streamingLive: StreamingLiveBuffers
  streamingCompletedSteps: Array<{
    stepId: string
    stepIndex: number
    blocks: TurnContentBlock[]
  }>
  permissions: PermissionDecision[]
  onReplyPermission?: (permissionId: string, reply: 'once' | 'always' | 'reject') => void
  scrollContainerRef?: React.RefObject<HTMLElement | null>
}

export const SessionLiveTurn = memo(function SessionLiveTurn({
  steps,
  streamingStepId,
  streamingLive,
  streamingCompletedSteps,
  permissions,
  onReplyPermission,
  scrollContainerRef,
}: Props) {
  const isNearBottom = useRef(true)

  const streamingStep = streamingStepId ? steps.find(step => step.id === streamingStepId) : undefined
  const showLiveBlock = Boolean(streamingStepId) && (!streamingStep || streamingStep.status === 'running')
  const hasPendingApproval = listPendingGoalPermissions(permissions).length > 0

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

  if (!showLiveBlock && streamingCompletedSteps.length === 0 && !(onReplyPermission && hasPendingApproval)) {
    return null
  }

  return (
    <>
      {streamingCompletedSteps.map(step => (
        <CompletedStepView
          key={step.stepId}
          blocks={step.blocks}
        />
      ))}
      {showLiveBlock ? (
        <LiveStepView streamingLive={streamingLive} />
      ) : null}
      {onReplyPermission && hasPendingApproval ? (
        <div className="session-context-approval mx-auto w-full max-w-3xl rounded-2xl border border-border/50 bg-card/80 p-3 shadow-sm backdrop-blur-sm">
          <GoalQuickApproval
            permissions={permissions}
            onReply={onReplyPermission}
            variant="strip"
            showIndicator
          />
        </div>
      ) : null}
    </>
  )
})
