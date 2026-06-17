import { X, Loader2 } from 'lucide-react'
import { useDebugConsole } from './debugConsoleStore'
import { AgentConversationView } from '../sessions/AgentConversationView'

interface Props {
  sessionId: string
}

export function DebugPanel({ sessionId }: Props) {
  const session = useDebugConsole(s => s.sessions.find(ss => ss.id === sessionId))
  const runs = useDebugConsole(s => s.runs)
  const steps = useDebugConsole(s => s.steps)
  const toolCalls = useDebugConsole(s => s.toolCalls)
  const messages = useDebugConsole(s => s.messages)
  const closePanel = useDebugConsole(s => s.closePanel)

  const isRunning = session?.status === 'running'

  return (
    <div className="debug-panel animate-in fade-in slide-in-from-top-1 duration-200">
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
