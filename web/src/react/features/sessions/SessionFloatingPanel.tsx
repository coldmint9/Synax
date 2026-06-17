import { X, Loader2 } from 'lucide-react'
import { useAgentSessionStore } from './agentSessionStore'
import { AgentConversationView } from './AgentConversationView'

interface Props {
  sessionId: string
}

export function SessionFloatingPanel({ sessionId }: Props) {
  const session = useAgentSessionStore(s => s.sessions.find(ss => ss.id === sessionId))
  const runs = useAgentSessionStore(s => s.runs)
  const steps = useAgentSessionStore(s => s.steps)
  const toolCalls = useAgentSessionStore(s => s.toolCalls)
  const messages = useAgentSessionStore(s => s.messages)
  const closePanel = useAgentSessionStore(s => s.closePanel)

  const isRunning = session?.status === 'running'

  return (
    <div className="session-floating-panel animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {isRunning && <Loader2 size={12} className="animate-spin text-[var(--color-run)]" />}
          <span className="truncate text-xs font-medium">{session?.prompt ?? sessionId}</span>
        </div>
        <button
          type="button"
          onClick={closePanel}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary/60"
        >
          <X size={13} />
        </button>
      </div>

      <div className="max-h-[55vh] overflow-y-auto">
        <AgentConversationView
          session={session}
          runs={runs}
          steps={steps}
          toolCalls={toolCalls}
          messages={messages}
        />
      </div>
    </div>
  )
}
