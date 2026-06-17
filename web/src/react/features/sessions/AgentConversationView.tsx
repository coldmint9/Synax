import { useMemo, useRef, useEffect, useCallback } from 'react'
import { Chip, ProgressBar, Skeleton, Card } from '@heroui/react'
import { Pause, Play, XCircle, Zap } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import type { AgentRun, AgentRunStep, AgentRuntimeMessage, AgentSession, PermissionDecision, ToolCallRecord } from '../../../lib/api/agentRuntime'
import type { CompactionEvent } from '../../state/agentRuntimeStore'
import { buildConversationTimeline, sessionEntryDomId, type ConversationTimelineEntry } from './buildConversationTimeline'
import { type TurnContentBlock } from './buildInterleavedTurns'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { SubSessionCard } from './SubSessionCard'
import { ThinkingIndicator } from './ThinkingIndicator'
import { getSessionCategory } from './sessionGrouping'
import { GoalQuickApproval, listPendingGoalPermissions } from '../wiki/goal/GoalQuickApproval'
import { UserMessageBlock } from './UserMessageBlock'
import { ToolCallRoundPanel } from './ToolCallRoundPanel'
import { buildTurnRenderSegments, toolCallRecordToView } from './toolCallUtils'

interface Props {
  session: AgentSession | undefined
  runs?: AgentRun[]
  steps: AgentRunStep[]
  toolCalls: ToolCallRecord[]
  messages: AgentRuntimeMessage[]
  childSessions?: AgentSession[]
  compactions?: CompactionEvent[]
  onPause?: (sessionId: string) => void
  onResume?: (sessionId: string) => void
  onCancel?: (sessionId: string) => void
  onExpandChild?: (sessionId: string) => void
  streamingStepId?: string | null
  streamingText?: string
  streamingThinking?: string
  streamingToolCalls?: ToolCallRecord[]
  streamingCompletedSteps?: Array<{
    stepId: string
    stepIndex: number
    text: string
    thinking: string
    toolCalls: ToolCallRecord[]
  }>
  permissions?: PermissionDecision[]
  onReplyPermission?: (permissionId: string, reply: 'once' | 'always' | 'reject') => void
  scrollContainerRef?: React.RefObject<HTMLElement | null>
}

const STATUS_MAP: Record<string, { text: string; color: 'accent' | 'success' | 'danger' | 'warning' | 'default' }> = {
  running: { text: 'running', color: 'accent' },
  completed: { text: 'completed', color: 'success' },
  failed: { text: 'failed', color: 'danger' },
  interrupted: { text: 'warning', color: 'warning' },
  paused: { text: 'paused', color: 'default' },
  waiting_permission: { text: 'waiting', color: 'warning' },
  blocked: { text: 'blocked', color: 'warning' },
  cancelled: { text: 'cancelled', color: 'default' },
  queued: { text: 'draft', color: 'default' },
}

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

function renderTurnBlocks(
  blocks: TurnContentBlock[],
  onExpandChild?: (sessionId: string) => void,
) {
  const segments = buildTurnRenderSegments(blocks)

  return segments.map((segment, i) => {
    if (segment.type === 'thinking') {
      return <ThinkingBlock key={i} content={segment.content} />
    }
    if (segment.type === 'tool_round') {
      return <ToolCallRoundPanel key={i} toolBlocks={segment.toolBlocks} />
    }
    if (segment.type === 'text') {
      return (
        <StreamingTextBlock
          key={i}
          text={segment.content}
          isStreaming={false}
          markdown={segment.markdown}
        />
      )
    }
    if (segment.type === 'sub_session') {
      return <SubSessionCard key={i} session={segment.session} onExpand={onExpandChild} />
    }
    if (segment.type === 'context_compacted') {
      return (
        <div key={i} className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-1.5 text-[11px] text-warning">
          <Zap size={12} />
          <span>上下文压缩: {segment.originalTokens.toLocaleString()} → {segment.compressedTokens.toLocaleString()} tokens ({segment.messageCount} 条消息被摘要)</span>
        </div>
      )
    }
    return null
  })
}

function renderStreamingStep(
  thinking: string,
  text: string,
  toolCalls: ToolCallRecord[],
  isLive: boolean,
) {
  const hasTools = toolCalls.length > 0
  const showFinalMarkdown = Boolean(text) && !hasTools && !isLive

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-2">
      {thinking && <ThinkingBlock content={thinking} isStreaming={isLive} />}
      {hasTools && (
        <ToolCallRoundPanel toolBlocks={toolCallsToBlocks(toolCalls)} />
      )}
      {text && (
        <StreamingTextBlock
          text={text}
          isStreaming={isLive}
          markdown={showFinalMarkdown}
        />
      )}
      {isLive && !text && !thinking && !hasTools && (
        <ThinkingIndicator />
      )}
    </div>
  )
}

function renderTimelineEntry(
  entry: ConversationTimelineEntry,
  onExpandChild?: (sessionId: string) => void,
) {
  if (entry.kind === 'user') {
    return (
      <div
        id={sessionEntryDomId(entry.id)}
        className="scroll-mt-4"
        data-session-entry={entry.id}
      >
        <UserMessageBlock content={entry.content} />
      </div>
    )
  }

  return (
    <div
      id={sessionEntryDomId(entry.id)}
      className="scroll-mt-4"
      data-session-entry={entry.id}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        {renderTurnBlocks(entry.turn.blocks, onExpandChild)}
        {entry.turn.duration && (
          <div className="mt-1 text-[11px] text-muted-foreground/50">
            {entry.turn.duration}
          </div>
        )}
      </div>
    </div>
  )
}

export function AgentConversationView({
  session, runs = [], steps, toolCalls, messages, childSessions, compactions,
  onPause, onResume, onCancel, onExpandChild,
  streamingStepId, streamingText, streamingThinking, streamingToolCalls,
  streamingCompletedSteps,
  permissions = [],
  onReplyPermission,
  scrollContainerRef,
}: Props) {
  const { t } = useLocale()
  const isNearBottom = useRef(true)

  const streamingStep = streamingStepId ? steps.find(s => s.id === streamingStepId) : undefined
  const showLiveBlock = !!streamingStepId && (!streamingStep || streamingStep.status === 'running')

  const timeline = useMemo(
    () => buildConversationTimeline(
      runs,
      steps,
      messages,
      toolCalls,
      childSessions,
      { excludeStepId: showLiveBlock ? streamingStepId : null, session },
    ),
    [runs, steps, messages, toolCalls, childSessions, showLiveBlock, streamingStepId, session],
  )

  const isRunning = session?.status === 'running' && Boolean(session.activeRunId)
  const isResumable = session?.status === 'interrupted' || session?.status === 'paused' || session?.status === 'failed' || session?.status === 'blocked'
  const cat = session ? getSessionCategory(session.profileId) : null
  const statusInfo = session ? STATUS_MAP[session.status] : null
  const hasPendingApproval = listPendingGoalPermissions(permissions).length > 0

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef?.current
    if (!el) return
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [scrollContainerRef])

  useEffect(() => {
    const el = scrollContainerRef?.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [scrollContainerRef, handleScroll])

  useEffect(() => {
    const el = scrollContainerRef?.current
    if (isNearBottom.current && el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }, [scrollContainerRef, streamingText, streamingThinking, streamingToolCalls])

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2 border-b border-border/40 pb-3">
        <Chip size="sm" variant="soft" color="default" className="text-[11px]">
          {session?.profileId ?? 'agent'}
        </Chip>
        {cat?.isBuiltin && (
          <Chip size="sm" variant="secondary" color="accent" className="text-[10px]">
            {t('sessionBuiltin')}
          </Chip>
        )}
        {statusInfo && (
          <Chip size="sm" variant="soft" color={statusInfo.color} className="text-[11px]">
            {statusInfo.text}
          </Chip>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {isRunning && onPause && session && (
            <button
              type="button"
              onClick={() => onPause(session.id)}
              className="wh-pill-btn wh-pill-btn--neutral"
            >
              <Pause size={10} /> {t('sessionPause')}
            </button>
          )}
          {isResumable && onResume && session && (
            <button
              type="button"
              onClick={() => onResume(session.id)}
              className="wh-pill-btn wh-pill-btn--soft"
            >
              <Play size={10} /> {t('sessionResume')}
            </button>
          )}
          {isRunning && onCancel && session && (
            <button
              type="button"
              onClick={() => onCancel(session.id)}
              className="wh-pill-btn wh-pill-btn--danger-soft"
            >
              <XCircle size={10} /> {t('sessionCancel')}
            </button>
          )}
        </div>
      </div>

      {isRunning && (
        <ProgressBar size="sm" color="accent" className="w-full" isIndeterminate>
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      )}

      {compactions && compactions.length > 0 && compactions.map((c, i) => (
        <div key={`compaction-${i}`} className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-1.5 text-[11px] text-warning">
          <Zap size={12} />
          <span>上下文压缩: {c.originalTokens.toLocaleString()} → {c.compressedTokens.toLocaleString()} tokens ({c.messageCount} 条消息被摘要)</span>
        </div>
      ))}

      <div className="flex flex-col gap-5">
        {timeline.length === 0 && !showLiveBlock ? (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
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
        ) : (
          <>
            {timeline.map(entry => (
              <div key={`${entry.kind}-${entry.id}`}>
                {renderTimelineEntry(entry, onExpandChild)}
              </div>
            ))}

            {(streamingCompletedSteps ?? []).map(cs => (
              <div key={cs.stepId} className="animate-[fade-up_0.3s_ease-out]">
                {renderStreamingStep(cs.thinking, cs.text, cs.toolCalls, false)}
              </div>
            ))}

            {showLiveBlock && (
              <div>
                {renderStreamingStep(
                  streamingThinking ?? '',
                  streamingText ?? '',
                  streamingToolCalls ?? [],
                  true,
                )}
              </div>
            )}

            {onReplyPermission && hasPendingApproval && (
              <div className="session-context-approval mx-auto w-full max-w-3xl rounded-2xl border border-border/50 bg-card/80 p-3 shadow-sm backdrop-blur-sm">
                <GoalQuickApproval
                  permissions={permissions}
                  onReply={onReplyPermission}
                  variant="strip"
                  showIndicator
                />
              </div>
            )}
          </>
        )}
      </div>

      {session?.status === 'failed' && (
        <Card className="shadow-none border-destructive/15 bg-destructive/[0.03]">
          <div className="px-3.5 py-2.5">
            <Chip size="sm" color="danger" variant="soft" className="mb-1 text-[10px]">Failed</Chip>
            <div className="text-[13px] leading-relaxed text-muted-foreground">
              {session.blockedReason ?? 'Agent execution failed'}
            </div>
          </div>
        </Card>
      )}

      {isResumable && (
        <Card className="shadow-none border-sky-500/15 bg-sky-500/[0.03]">
          <div className="px-3.5 py-2.5">
            <Chip size="sm" color="default" variant="soft" className="mb-1 text-[10px]">
              {session?.status === 'paused' ? 'Paused' : 'Interrupted'}
            </Chip>
            <div className="text-[13px] leading-relaxed text-muted-foreground">
              {session?.blockedReason ?? t('sessionPausedHint')}
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
