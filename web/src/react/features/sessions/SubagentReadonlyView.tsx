import { memo, useCallback, useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import {
  agentRuntimeApi,
  type AgentRun,
  type AgentRunStep,
  type AgentRuntimeMessage,
  type AgentSession,
  type ToolCallRecord,
} from '../../../lib/api/agentRuntime'
import { AgentConversationView } from './AgentConversationView'
import { TranscriptSessionProvider } from './SessionTranscriptContext'

const REFRESH_MS = 4000

interface Detail {
  session: AgentSession
  runs: AgentRun[]
  steps: AgentRunStep[]
  messages: AgentRuntimeMessage[]
  toolCalls: ToolCallRecord[]
}

export const SubagentReadonlyView = memo(function SubagentReadonlyView({ sessionId }: { sessionId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [{ session }, runs, steps, messages, toolCalls] = await Promise.all([
        agentRuntimeApi.getSession(sessionId),
        agentRuntimeApi.listRuns(sessionId),
        agentRuntimeApi.listSessionSteps(sessionId),
        agentRuntimeApi.listMessages(sessionId),
        agentRuntimeApi.listToolCalls(sessionId),
      ])
      setDetail({ session, runs: runs.items, steps: steps.items, messages: messages.items, toolCalls: toolCalls.items })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法加载子会话')
    }
  }, [sessionId])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  if (error) {
    return <div className="flex h-full items-center justify-center p-4 text-[11px] text-destructive">{error}</div>
  }
  if (!detail) {
    return <div className="flex h-full items-center justify-center p-4 text-[11px] text-muted-foreground">加载子会话…</div>
  }

  return (
    <div className="session-workspace-scroll min-h-0 flex-1 overflow-auto">
      <div className="flex items-center gap-1.5 border-b border-border/30 bg-secondary/20 px-2.5 py-1.5">
        <Bot size={12} className="text-primary" />
        <span className="text-[10px] font-medium text-foreground">Subagent</span>
        <span className="truncate font-mono text-[9px] text-muted-foreground">{detail.session.id}</span>
        <span className="ml-auto rounded bg-secondary/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">只读</span>
      </div>
      <TranscriptSessionProvider sessionId={sessionId}>
        <AgentConversationView
          session={detail.session}
          runs={detail.runs}
          steps={detail.steps}
          toolCalls={detail.toolCalls}
          messages={detail.messages}
          childSessions={[]}
        />
      </TranscriptSessionProvider>
    </div>
  )
})
