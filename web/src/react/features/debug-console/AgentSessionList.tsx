import { Radio } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { useDebugConsole } from './debugConsoleStore'
import { useDebugPolling } from './useDebugPolling'
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

export function AgentSessionList() {
  useDebugPolling()

  const { projectId = '' } = useParams()
  const navigate = useNavigate()
  const sessions = useDebugConsole(s => s.sessions)
  const panelOpen = useDebugConsole(s => s.panelOpen)
  const selectedSessionId = useDebugConsole(s => s.selectedSessionId)
  const openPanel = useDebugConsole(s => s.openPanel)
  const closePanel = useDebugConsole(s => s.closePanel)

  const runningCount = sessions.filter(s =>
    s.status === 'running' || s.status === 'waiting_permission'
  ).length

  const handleClick = (sessionId: string) => {
    const active = sessionId === selectedSessionId && panelOpen
    if (active) {
      closePanel()
    } else {
      openPanel(sessionId)
      navigate(`/projects/${projectId}/sessions`)
    }
  }

  return (
    <div className="flex flex-col text-xs">
      <div className="flex items-center justify-between border-b border-border/40 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <Radio size={11} className={runningCount > 0 ? 'text-[hsl(var(--run))]' : ''} />
          Agent Sessions ({sessions.length})
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
          No active agent sessions
        </div>
      ) : (
        <ul className="divide-y divide-border/30">
          {sessions.slice().reverse().map(session => {
            const active = session.id === selectedSessionId && panelOpen
            return (
              <li
                key={session.id}
                className={`group cursor-pointer px-2 py-1.5 transition ${
                  active ? 'bg-primary/10 text-foreground' : 'hover:bg-secondary/40'
                }`}
                onClick={() => handleClick(session.id)}
              >
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[session.status]}`} />
                  <span className="truncate font-medium" title={session.prompt}>
                    {session.prompt.slice(0, 40)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[9px] text-muted-foreground">
                  <span>{session.status}</span>
                  {session.model && <span className="font-mono">{session.model}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
