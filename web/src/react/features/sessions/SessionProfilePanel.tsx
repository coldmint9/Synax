import { memo } from 'react'
import { Skeleton } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import { User } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentSessionStore } from './agentSessionStore'
import { SessionCapabilitiesPanel } from './SessionCapabilitiesPanel'
import { SessionStatusCard } from './SessionWorkspace'

export const SessionProfilePanel = memo(function SessionProfilePanel({
  sessionId,
}: {
  sessionId: string | null
}) {
  const { locale } = useLocale()
  const { loading, sessionStats, sessionTodos, sessionCapabilities, steps, runs, session } =
    useAgentSessionStore(
      useShallow((s) => ({
        loading: s.detailLoading,
        sessionStats: s.sessionStats,
        sessionTodos: s.sessionTodos,
        sessionCapabilities: s.sessionCapabilities,
        steps: s.steps,
        runs: s.runs,
        session: s.sessions.find((item) => item.id === sessionId),
      })),
    )

  return (
    <div className="session-profile-panel flex min-h-0 flex-col">
      <div className="session-profile-card-header">
        <span className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          <User size={10} />
          Status
        </span>
        {sessionId ? <span className="text-[8px] text-muted-foreground/50">当前会话</span> : null}
      </div>
      {!sessionId ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[10px] text-muted-foreground/60">
          选择会话后查看 Profile
        </div>
      ) : loading && !sessionStats && !sessionCapabilities ? (
        <div
          role="status"
          aria-label={locale === 'zh' ? '正在加载会话状态' : 'Loading session status'}
          className="space-y-4 p-3"
        >
          <Skeleton className="h-8 w-full rounded-lg" />
          <Skeleton className="h-4 w-3/4 rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessionStats && (
            <SessionStatusCard
              stats={sessionStats}
              session={session}
              runs={runs}
              steps={steps}
              todos={sessionTodos}
            />
          )}
          {sessionCapabilities && <SessionCapabilitiesPanel capabilities={sessionCapabilities} />}
        </div>
      )}
    </div>
  )
})
