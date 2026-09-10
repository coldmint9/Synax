import { memo } from 'react'
import { User } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentSessionStore } from './agentSessionStore'
import { SessionCapabilitiesPanel } from './SessionCapabilitiesPanel'
import { SessionStatusCard } from './SessionWorkspace'

export const SessionProfilePanel = memo(function SessionProfilePanel({ sessionId }: { sessionId: string | null }) {
  const { sessionStats, sessionTodos, sessionCapabilities, steps } = useAgentSessionStore(useShallow(s => ({
    sessionStats: s.sessionStats,
    sessionTodos: s.sessionTodos,
    sessionCapabilities: s.sessionCapabilities,
    steps: s.steps,
  })))

  return (
    <div className="session-profile-panel flex min-h-0 flex-col">
      <div className="session-profile-card-header">
        <span className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          <User size={10} />
          Profile
        </span>
        {sessionId ? <span className="text-[8px] text-muted-foreground/50">当前会话</span> : null}
      </div>
      {!sessionId ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[10px] text-muted-foreground/60">
          选择会话后查看 Profile
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessionStats && <SessionStatusCard stats={sessionStats} steps={steps} todos={sessionTodos} />}
          {sessionCapabilities && <SessionCapabilitiesPanel capabilities={sessionCapabilities} />}
        </div>
      )}
    </div>
  )
})
