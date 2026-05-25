import { useMemo, useRef, useEffect } from 'react'
import { Chip, ProgressBar, ScrollShadow, Skeleton, Card } from '@heroui/react'
import { Bot, Pause, Play, XCircle } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import type { AgentRunStep, AgentRuntimeMessage, AgentSession, ToolCallRecord } from '../../../lib/api/agentRuntime'
import { buildInterleavedTurns } from './buildInterleavedTurns'
import { EnhancedToolCallCard } from './EnhancedToolCallCard'
import { ParallelToolCallGroup } from './ParallelToolCallGroup'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { SubSessionCard } from './SubSessionCard'
import { getSessionCategory } from './sessionGrouping'

interface Props {
  session: AgentSession | undefined
  steps: AgentRunStep[]
  toolCalls: ToolCallRecord[]
  messages: AgentRuntimeMessage[]
  childSessions?: AgentSession[]
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
}

const STATUS_MAP: Record<string, { text: string; color: 'primary' | 'success' | 'danger' | 'warning' | 'default' }> = {
  running: { text: 'running', color: 'primary' },
  completed: { text: 'completed', color: 'success' },
  failed: { text: 'failed', color: 'danger' },
  interrupted: { text: 'warning', color: 'warning' },
  paused: { text: 'paused', color: 'default' },
  waiting_permission: { text: 'waiting', color: 'warning' },
  blocked: { text: 'blocked', color: 'warning' },
  cancelled: { text: 'cancelled', color: 'default' },
}

export function AgentConversationView({
  session, steps, toolCalls, messages, childSessions,
  onPause, onResume, onCancel, onExpandChild,
  streamingStepId, streamingText, streamingThinking, streamingToolCalls,
  streamingCompletedSteps,
}: Props) {
  const { t } = useLocale()
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottom = useRef(true)

  const turns = useMemo(
    () => buildInterleavedTurns(steps, toolCalls, messages, childSessions),
    [steps, toolCalls, messages, childSessions],
  )

  const isRunning = session?.status === 'running'
  const isResumable = session?.status === 'interrupted' || session?.status === 'paused' || session?.status === 'failed'
  const cat = session ? getSessionCategory(session.profileId) : null
  const statusInfo = session ? STATUS_MAP[session.status] : null

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    if (isNearBottom.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [streamingText, streamingThinking, streamingToolCalls])

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Session header */}
      <div className="flex items-center gap-2 border-b border-border/40 pb-3">
        <Chip size="sm" variant="flat" color="secondary" className="text-[11px]">
          {session?.profileId ?? 'agent'}
        </Chip>
        {cat?.isBuiltin && (
          <Chip size="sm" variant="bordered" color="primary" className="text-[10px]">
            {t('sessionBuiltin')}
          </Chip>
        )}
        {statusInfo && (
          <Chip size="sm" variant="dot" color={statusInfo.color} className="text-[11px]">
            {statusInfo.text}
          </Chip>
        )}
        {/* Actions */}
        <div className="ml-auto flex items-center gap-1.5">
          {isRunning && onPause && session && (
            <button
              type="button"
              onClick={() => onPause(session.id)}
              className="flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-[10px] text-muted-foreground hover:bg-secondary/50"
            >
              <Pause size={10} /> {t('sessionPause')}
            </button>
          )}
          {isResumable && onResume && session && (
            <button
              type="button"
              onClick={() => onResume(session.id)}
              className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[10px] text-primary hover:bg-primary/10"
            >
              <Play size={10} /> {t('sessionResume')}
            </button>
          )}
          {isRunning && onCancel && session && (
            <button
              type="button"
              onClick={() => onCancel(session.id)}
              className="flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-[10px] text-destructive/70 hover:bg-destructive/5"
            >
              <XCircle size={10} /> {t('sessionCancel')}
            </button>
          )}
        </div>
      </div>

      {/* Progress bar when running */}
      {isRunning && <ProgressBar isIndeterminate size="sm" color="primary" className="w-full" />}

      {/* Prompt */}
      {session?.prompt && (
        <Card className="shadow-none border-border/50 bg-secondary/30">
          <div className="px-3.5 py-2.5 text-[13px] leading-relaxed text-muted-foreground whitespace-pre-wrap line-clamp-3">
            {session.prompt}
          </div>
        </Card>
      )}

      {/* Turns */}
      <ScrollShadow ref={scrollRef} className="flex-1 min-h-0" onScroll={handleScroll}>
        {turns.length === 0 && !streamingStepId ? (
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
          <div className="flex flex-col gap-5">
            {turns.map(turn => (
              <div key={turn.stepId} className="flex gap-3">
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--agent))]/15 bg-[hsl(var(--agent))]/[0.04]">
                  <Bot size={14} className="text-[var(--color-agent)]" />
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  {turn.blocks.map((block, i) => {
                    if (block.type === 'text') {
                      return (
                        <StreamingTextBlock key={i} text={block.content} isStreaming={false} />
                      )
                    }
                    if (block.type === 'thinking') {
                      return <ThinkingBlock key={i} content={block.content} />
                    }
                    if (block.type === 'tool_call') {
                      return <EnhancedToolCallCard key={i} call={block.call} />
                    }
                    if (block.type === 'tool_call_group') {
                      return <ParallelToolCallGroup key={i} calls={block.calls} />
                    }
                    if (block.type === 'sub_session') {
                      return <SubSessionCard key={i} session={block.session} onExpand={onExpandChild} />
                    }
                    return null
                  })}
                  {turn.duration && (
                    <div className="mt-1 text-[11px] text-muted-foreground/50">
                      {turn.duration}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Completed streaming steps (buffered before refreshDetail syncs) */}
            {(streamingCompletedSteps ?? []).map(cs => (
              <div key={cs.stepId} className="flex gap-3 animate-[fade-up_0.3s_ease-out]">
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--agent))]/15 bg-[hsl(var(--agent))]/[0.04]">
                  <Bot size={14} className="text-[var(--color-agent)]" />
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  {cs.thinking && <ThinkingBlock content={cs.thinking} />}
                  {cs.text && <StreamingTextBlock text={cs.text} isStreaming={false} />}
                  {cs.toolCalls.length > 1 ? (
                    <ParallelToolCallGroup
                      calls={cs.toolCalls.map(tc => ({
                        id: tc.id,
                        toolId: tc.toolId,
                        inputSummary: tc.inputSummary ?? '',
                        outputSummary: tc.outputSummary ?? '',
                        status: tc.status,
                        category: tc.category,
                        duration: tc.endedAt
                          ? `${((new Date(tc.endedAt).getTime() - new Date(tc.startedAt).getTime()) / 1000).toFixed(1)}s`
                          : null,
                        mutability: tc.mutability,
                      }))}
                    />
                  ) : cs.toolCalls.map(tc => (
                    <EnhancedToolCallCard
                      key={tc.id}
                      call={{
                        id: tc.id,
                        toolId: tc.toolId,
                        inputSummary: tc.inputSummary ?? '',
                        outputSummary: tc.outputSummary ?? '',
                        status: tc.status,
                        category: tc.category,
                        duration: tc.endedAt
                          ? `${((new Date(tc.endedAt).getTime() - new Date(tc.startedAt).getTime()) / 1000).toFixed(1)}s`
                          : null,
                        mutability: tc.mutability,
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* Streaming turn */}
            {streamingStepId && !steps.find(s => s.id === streamingStepId) && (
              <div className="flex gap-3">
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--agent))]/15 bg-[hsl(var(--agent))]/[0.04]">
                  <Bot size={14} className="text-[var(--color-agent)]" />
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  {streamingThinking && <ThinkingBlock content={streamingThinking} isStreaming />}
                  {streamingText && (
                    <StreamingTextBlock text={streamingText} isStreaming />
                  )}
                  {(streamingToolCalls ?? []).length > 1 ? (
                    <ParallelToolCallGroup
                      calls={(streamingToolCalls ?? []).map(tc => ({
                        id: tc.id,
                        toolId: tc.toolId,
                        inputSummary: tc.inputSummary ?? '',
                        outputSummary: tc.outputSummary ?? '',
                        status: tc.status,
                        category: tc.category,
                        duration: tc.endedAt
                          ? `${((new Date(tc.endedAt).getTime() - new Date(tc.startedAt).getTime()) / 1000).toFixed(1)}s`
                          : null,
                        mutability: tc.mutability,
                      }))}
                    />
                  ) : (streamingToolCalls ?? []).map(tc => (
                    <EnhancedToolCallCard
                      key={tc.id}
                      call={{
                        id: tc.id,
                        toolId: tc.toolId,
                        inputSummary: tc.inputSummary ?? '',
                        outputSummary: tc.outputSummary ?? '',
                        status: tc.status,
                        category: tc.category,
                        duration: tc.endedAt
                          ? `${((new Date(tc.endedAt).getTime() - new Date(tc.startedAt).getTime()) / 1000).toFixed(1)}s`
                          : null,
                        mutability: tc.mutability,
                      }}
                    />
                  ))}
                  {!streamingText && !streamingThinking && (streamingToolCalls ?? []).length === 0 && (
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-3 w-24 rounded-md" />
                      <Skeleton className="h-3 w-16 rounded-md" />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </ScrollShadow>

      {/* Result */}
      {session?.status === 'completed' && session.resultSummary && (
        <Card className="shadow-none border-success/15 bg-success/[0.03]">
          <div className="px-3.5 py-2.5">
            <Chip size="sm" color="success" variant="flat" className="mb-1 text-[10px]">Completed</Chip>
            <div className="text-[13px] leading-relaxed text-muted-foreground">
              {session.resultSummary}
            </div>
          </div>
        </Card>
      )}

      {session?.status === 'failed' && (
        <Card className="shadow-none border-destructive/15 bg-destructive/[0.03]">
          <div className="px-3.5 py-2.5">
            <Chip size="sm" color="danger" variant="flat" className="mb-1 text-[10px]">Failed</Chip>
            <div className="text-[13px] leading-relaxed text-muted-foreground">
              {session.blockedReason ?? 'Agent execution failed'}
            </div>
          </div>
        </Card>
      )}

      {isResumable && (
        <Card className="shadow-none border-sky-500/15 bg-sky-500/[0.03]">
          <div className="px-3.5 py-2.5">
            <Chip size="sm" color="default" variant="flat" className="mb-1 text-[10px]">
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
