import { memo, useDeferredValue, useEffect, useRef } from 'react'
import type { AgentRunStep, PermissionDecision, ToolCallRecord } from '../../../lib/api/agentRuntime'
import { GoalQuickApproval, listPendingGoalPermissions } from '../wiki/goal/GoalQuickApproval'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { ThinkingIndicator } from './ThinkingIndicator'
import { ToolCallRoundPanel } from './ToolCallRoundPanel'
import { toolCallRecordToView } from './toolCallUtils'
import type { TurnContentBlock } from './buildInterleavedTurns'

function toolCallsToBlocks(toolCalls: ToolCallRecord[]): TurnContentBlock[] {
  if (toolCalls.length === 0) return []
  if (toolCalls.length === 1) {
    return [{ type: 'tool_call', call: toolCallRecordToView(toolCalls[0]) }]
  }
  return [{
    type: 'tool_call_group',
    calls: toolCalls.map(toolCallRecordToView),
  }]
}

const CompletedStepView = memo(function CompletedStepView({
  thinking,
  text,
  toolCalls,
}: {
  thinking: string
  text: string
  toolCalls: ToolCallRecord[]
}) {
  const hasTools = toolCalls.length > 0
  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {thinking ? <ThinkingBlock content={thinking} /> : null}
        {hasTools ? <ToolCallRoundPanel toolBlocks={toolCallsToBlocks(toolCalls)} /> : null}
        {text ? <StreamingTextBlock text={text} isStreaming={false} markdown={!hasTools} /> : null}
      </div>
    </div>
  )
})

const LiveStepView = memo(function LiveStepView({
  thinking,
  text,
  toolCalls,
}: {
  thinking: string
  text: string
  toolCalls: ToolCallRecord[]
}) {
  const deferredText = useDeferredValue(text)
  const deferredThinking = useDeferredValue(thinking)
  const hasTools = toolCalls.length > 0
  const showFinalMarkdown = Boolean(deferredText) && !hasTools

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {deferredThinking ? <ThinkingBlock content={deferredThinking} isStreaming /> : null}
      {hasTools ? <ToolCallRoundPanel toolBlocks={toolCallsToBlocks(toolCalls)} /> : null}
      {deferredText ? (
        <StreamingTextBlock text={deferredText} isStreaming markdown={showFinalMarkdown} />
      ) : null}
      {!deferredText && !deferredThinking && !hasTools ? <ThinkingIndicator /> : null}
    </div>
  )
})

interface Props {
  steps: AgentRunStep[]
  streamingStepId: string | null
  streamingText: string
  streamingThinking: string
  streamingToolCalls: ToolCallRecord[]
  streamingCompletedSteps: Array<{
    stepId: string
    stepIndex: number
    text: string
    thinking: string
    toolCalls: ToolCallRecord[]
  }>
  permissions: PermissionDecision[]
  onReplyPermission?: (permissionId: string, reply: 'once' | 'always' | 'reject') => void
  scrollContainerRef?: React.RefObject<HTMLElement | null>
}

export const SessionLiveTurn = memo(function SessionLiveTurn({
  steps,
  streamingStepId,
  streamingText,
  streamingThinking,
  streamingToolCalls,
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
  }, [scrollContainerRef, streamingText, streamingThinking, streamingToolCalls, streamingCompletedSteps.length])

  if (!showLiveBlock && streamingCompletedSteps.length === 0 && !(onReplyPermission && hasPendingApproval)) {
    return null
  }

  return (
    <>
      {streamingCompletedSteps.map(step => (
        <CompletedStepView
          key={step.stepId}
          thinking={step.thinking}
          text={step.text}
          toolCalls={step.toolCalls}
        />
      ))}
      {showLiveBlock ? (
        <LiveStepView
          thinking={streamingThinking}
          text={streamingText}
          toolCalls={streamingToolCalls}
        />
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
