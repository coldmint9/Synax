import { ChevronDown, ChevronUp, Radio } from 'lucide-react'
import { useAgentSessionStore } from './agentSessionStore'
import { useSessionDetailPolling } from './useSessionDetailPolling'
import { SessionFloatingPanel } from './SessionFloatingPanel'
import type { AgentSessionStatus } from '../../../lib/api/agentRuntime'

const STATUS_DOT: Record<AgentSessionStatus, string> = {
  running: 'bg-[var(--color-run)] animate-pulse',
  waiting_permission: 'bg-warning',
  blocked: 'bg-warning',
  completed: 'bg-success',
  failed: 'bg-danger',
  interrupted: 'bg-amber-400',
  paused: 'bg-sky-400',
  queued: 'bg-muted-foreground/50',
  cancelled: 'bg-muted-foreground/30',
}

export function SessionQuickToolbar() {
  useSessionDetailPolling()

  const sessions = useAgentSessionStore(s => s.sessions)
  const panelOpen = useAgentSessionStore(s => s.panelOpen)
  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)
  const openPanel = useAgentSessionStore(s => s.openPanel)
  const closePanel = useAgentSessionStore(s => s.closePanel)

  const runningCount = sessions.filter(s =>
    s.status === 'running' || s.status === 'waiting_permission'
  ).length

  return (
    <>
      <div className="session-quick-toolbar">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Radio size={12} className={runningCount > 0 ? 'text-[var(--color-run)]' : ''} />
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
                  'session-quick-pill',
                  selectedSessionId === session.id && panelOpen ? 'session-quick-pill-active' : '',
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
        <SessionFloatingPanel sessionId={selectedSessionId} />
      )}
    </>
  )
}
