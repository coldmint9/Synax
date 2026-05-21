import { useMemo, useState } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import type { AgentRunStep, AgentRuntimeMessage, AgentSession, ToolCallRecord } from '../../../lib/api/agentRuntime'
import { buildConversationTurns } from './buildConversationTurns'
import { ToolCallCard } from './ToolCallCard'

interface Props {
  session: AgentSession | undefined
  steps: AgentRunStep[]
  toolCalls: ToolCallRecord[]
  messages: AgentRuntimeMessage[]
}

export function AgentConversationView({ session, steps, toolCalls, messages }: Props) {
  const [promptExpanded, setPromptExpanded] = useState(false)

  const turns = useMemo(
    () => buildConversationTurns(steps, toolCalls, messages),
    [steps, toolCalls, messages],
  )

  const isRunning = session?.status === 'running'

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* Session header */}
      <div className="flex items-center gap-2.5 border-b border-border/40 pb-3">
        <span className="rounded-md border border-[hsl(var(--agent))]/20 bg-[hsl(var(--agent))]/[0.06] px-2.5 py-0.5 text-[11px] font-semibold text-[hsl(var(--agent))]">
          {session?.profileId ?? 'agent'}
        </span>
        {isRunning && (
          <span className="flex items-center gap-1.5 text-xs text-[hsl(var(--agent))]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[hsl(var(--agent))]" />
            running
          </span>
        )}
        {session?.status === 'completed' && (
          <span className="text-xs text-[hsl(var(--success))]">completed</span>
        )}
        {session?.status === 'failed' && (
          <span className="text-xs text-destructive">failed</span>
        )}
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
      {turns.length === 0 ? (
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
              <div className="flex-1 min-w-0">
                {turn.assistantText && (
                  <div className="mb-3 text-sm leading-[1.75] text-foreground whitespace-pre-wrap">
                    {turn.assistantText}
                  </div>
                )}
                {turn.toolCalls.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {turn.toolCalls.map(tc => (
                      <ToolCallCard key={tc.id} call={tc} />
                    ))}
                  </div>
                )}
                {turn.duration && (
                  <div className="mt-2 text-[11px] text-muted-foreground/50">
                    {turn.duration}
                  </div>
                )}
              </div>
            </div>
          ))}
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
    </div>
  )
}