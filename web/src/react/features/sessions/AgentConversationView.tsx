import { useMemo, useState } from 'react'
import { Bot, Loader2, Pause, Play, BookOpen, XCircle } from 'lucide-react'
import type { AgentRunStep, AgentRuntimeMessage, AgentSession, ToolCallRecord } from '../../../lib/api/agentRuntime'
import { buildInterleavedTurns } from './buildInterleavedTurns'
import { EnhancedToolCallCard } from './EnhancedToolCallCard'
import { ThinkingBlock } from './ThinkingBlock'
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
}

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  running: { text: 'running', color: 'text-[hsl(var(--agent))]' },
  completed: { text: 'completed', color: 'text-[hsl(var(--success))]' },
  failed: { text: 'failed', color: 'text-destructive' },
  interrupted: { text: 'interrupted', color: 'text-amber-500' },
  paused: { text: 'paused', color: 'text-sky-500' },
  waiting_permission: { text: 'waiting', color: 'text-[hsl(var(--warning))]' },
  blocked: { text: 'blocked', color: 'text-[hsl(var(--warning))]' },
  cancelled: { text: 'cancelled', color: 'text-muted-foreground' },
}

export function AgentConversationView({
  session, steps, toolCalls, messages, childSessions,
  onPause, onResume, onCancel, onExpandChild,
  streamingStepId, streamingText, streamingThinking, streamingToolCalls,
}: Props) {
  const [promptExpanded, setPromptExpanded] = useState(false)

  const turns = useMemo(
    () => buildInterleavedTurns(steps, toolCalls, messages, childSessions),
    [steps, toolCalls, messages, childSessions],
  )

  const isRunning = session?.status === 'running'
  const isResumable = session?.status === 'interrupted' || session?.status === 'paused' || session?.status === 'failed'
  const cat = session ? getSessionCategory(session.profileId) : null
  const statusInfo = session ? STATUS_LABEL[session.status] : null

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* Session header */}
      <div className="flex items-center gap-2.5 border-b border-border/40 pb-3">
        <span className="rounded-md border border-[hsl(var(--agent))]/20 bg-[hsl(var(--agent))]/[0.06] px-2.5 py-0.5 text-[11px] font-semibold text-[hsl(var(--agent))]">
          {session?.profileId ?? 'agent'}
        </span>
        {cat?.isBuiltin && (
          <span className="flex items-center gap-1 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <BookOpen size={10} />
            内建
          </span>
        )}
        {statusInfo && (
          <span className={`flex items-center gap-1.5 text-xs ${statusInfo.color}`}>
            {isRunning && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
            {statusInfo.text}
          </span>
        )}
        {/* Actions */}
        <div className="ml-auto flex items-center gap-1.5">
          {isRunning && onPause && session && (
            <button
              type="button"
              onClick={() => onPause(session.id)}
              className="flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-[10px] text-muted-foreground hover:bg-secondary/50"
            >
              <Pause size={10} /> 暂停
            </button>
          )}
          {isResumable && onResume && session && (
            <button
              type="button"
              onClick={() => onResume(session.id)}
              className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[10px] text-primary hover:bg-primary/10"
            >
              <Play size={10} /> 恢复
            </button>
          )}
          {isRunning && onCancel && session && (
            <button
              type="button"
              onClick={() => onCancel(session.id)}
              className="flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-[10px] text-destructive/70 hover:bg-destructive/5"
            >
              <XCircle size={10} /> 取消
            </button>
          )}
        </div>
      </div>

      {/* Prompt */}
      {session?.prompt && (
        <div className="rounded-lg border border-border/50 bg-secondary/30 px-3.5 py-2.5">
          <div
            className={`text-[13px] leading-relaxed text-muted-foreground whitespace-pre-wrap ${
              !promptExpanded ? 'line-clamp-2' : ''
            }`}
          >
            {session.prompt}
          </div>
          {session.prompt.length > 120 && (
            <button
              type="button"
              onClick={() => setPromptExpanded(!promptExpanded)}
              className="mt-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground"
            >
              {promptExpanded ? '收起' : '展开全部'}
            </button>
          )}
        </div>
      )}

      {/* Turns */}
      {turns.length === 0 && !streamingStepId ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground/50">
          {isRunning ? (
            <span className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              等待输出...
            </span>
          ) : (
            '暂无执行记录'
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {turns.map(turn => (
            <div key={turn.stepId} className="flex gap-3.5">
              <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--agent))]/15 bg-[hsl(var(--agent))]/[0.04]">
                <Bot size={14} className="text-[hsl(var(--agent))]" />
              </div>
              <div className="flex-1 min-w-0 flex flex-col gap-2">
                {turn.blocks.map((block, i) => {
                  if (block.type === 'text') {
                    return (
                      <div key={i} className="text-sm leading-[1.75] text-foreground whitespace-pre-wrap">
                        {block.content}
                      </div>
                    )
                  }
                  if (block.type === 'thinking') {
                    return <ThinkingBlock key={i} content={block.content} />
                  }
                  if (block.type === 'tool_call') {
                    return <EnhancedToolCallCard key={i} call={block.call} />
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

          {/* 流式进行中的 turn */}
          {streamingStepId && !steps.find(s => s.id === streamingStepId) && (
            <div className="flex gap-3.5">
              <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--agent))]/15 bg-[hsl(var(--agent))]/[0.04]">
                <Bot size={14} className="text-[hsl(var(--agent))]" />
              </div>
              <div className="flex-1 min-w-0 flex flex-col gap-2">
                {streamingThinking && <ThinkingBlock content={streamingThinking} />}
                {streamingText && (
                  <div className="text-sm leading-[1.75] text-foreground whitespace-pre-wrap">
                    {streamingText}
                    <span className="inline-block w-0.5 h-[1em] bg-foreground/60 animate-pulse ml-0.5 align-text-bottom" />
                  </div>
                )}
                {(streamingToolCalls ?? []).map(tc => (
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
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground/50">
                    <Loader2 size={12} className="animate-spin" />
                    思考中...
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Result */}
      {session?.status === 'completed' && session.resultSummary && (
        <div className="rounded-lg border border-[hsl(var(--success))]/15 bg-[hsl(var(--success))]/[0.03] px-3.5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[hsl(var(--success))] mb-1">
            Completed
          </div>
          <div className="text-[13px] leading-relaxed text-muted-foreground">
            {session.resultSummary}
          </div>
        </div>
      )}

      {session?.status === 'failed' && (
        <div className="rounded-lg border border-destructive/15 bg-destructive/[0.03] px-3.5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-destructive mb-1">
            Failed
          </div>
          <div className="text-[13px] leading-relaxed text-muted-foreground">
            {session.blockedReason ?? 'Agent execution failed'}
          </div>
        </div>
      )}

      {isResumable && (
        <div className="rounded-lg border border-sky-500/15 bg-sky-500/[0.03] px-3.5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-500 mb-1">
            {session?.status === 'paused' ? 'Paused' : 'Interrupted'}
          </div>
          <div className="text-[13px] leading-relaxed text-muted-foreground">
            {session?.blockedReason ?? '会话已暂停，可随时恢复执行'}
          </div>
        </div>
      )}
    </div>
  )
}
