import { ChevronDown, ChevronUp, Radio } from 'lucide-react'
import { useDebugConsole } from './debugConsoleStore'
import { useDebugPolling } from './useDebugPolling'
import { DebugPanel } from './DebugPanel'
import type { AgentSessionStatus } from '../../../lib/api/agentRuntime'

const STATUS_DOT: Record<AgentSessionStatus, string> = {
  running: 'bg-[hsl(var(--run))] animate-pulse',
  waiting_permission: 'bg-[hsl(var(--warning))]',
  blocked: 'bg-[hsl(var(--warning))]',
  completed: 'bg-[hsl(var(--success))]',
  failed: 'bg-[hsl(var(--destructive))]',
  queued: 'bg-muted-foreground/50',
  cancelled: 'bg-muted-foreground/30',
}

export function DebugToolbar() {
  useDebugPolling()

  const sessions = useDebugConsole(s => s.sessions)
  const panelOpen = useDebugConsole(s => s.panelOpen)
  const selectedSessionId = useDebugConsole(s => s.selectedSessionId)
  const openPanel = useDebugConsole(s => s.openPanel)
  const closePanel = useDebugConsole(s => s.closePanel)

  const runningCount = sessions.filter(s =>
    s.status === 'running' || s.status === 'waiting_permission'
  ).length

  return (
    <>
      <div className="debug-toolbar">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Radio size={12} className={runningCount > 0 ? 'text-[hsl(var(--run))]' : ''} />
          <span className="font-medium">{sessions.length}</span>
        </div>

        {sessions.length === 0 ? (
          <span className="text-[10px] text-muted-foreground/60">No active sessions</span>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none">
            {sessions.slice().reverse().map(session => (
              <button
                key={session.id}
                type="button"
                onClick={() => selectedSessionId === session.id && panelOpen
                  ? closePanel()
                  : openPanel(session.id)
                }
                className={[
                  'debug-pill',
                  selectedSessionId === session.id && panelOpen ? 'debug-pill-active' : '',
                ].join(' ')}
                title={session.prompt}
              >
                <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[session.status]}`} />
                <span className="truncate">{session.prompt.slice(0, 32)}</span>
              </button>
            ))}
          </div>
        )}

        {sessions.length > 0 && (
          <button
            type="button"
            onClick={() => panelOpen ? closePanel() : (sessions[0] && openPanel(sessions[0].id))}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary/60"
          >
            {panelOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
      </div>

      {panelOpen && selectedSessionId && (
        <DebugPanel sessionId={selectedSessionId} />
      )}
    </>
  )
}