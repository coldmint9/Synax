import { memo } from 'react'
import { IdCard } from 'lucide-react'
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
    <div className="session-profile-panel flex min-h-0 flex-col border-t border-border/40">
      <div className="session-profile-header flex shrink-0 items-center gap-1.5 px-2.5 py-2">
        <IdCard size={12} className="text-primary" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground">Profile</span>
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
