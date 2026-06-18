import { useEffect } from 'react'
import { useAgentSessionStore } from './agentSessionStore'
import { subscribe } from '../../../lib/api/runtimeEventBus'
import type { AgentSession } from '../../../lib/api/agentRuntime'

export function useRuntimeSSE() {
  const refreshSessions = useAgentSessionStore(s => s.refreshSessions)
  const refreshDetail = useAgentSessionStore(s => s.refreshDetail)
  const patchSession = useAgentSessionStore(s => s.patchSession)

  useEffect(() => {
    return subscribe({
      onConnect: () => void refreshSessions(),
      events: {
        session_changed: (e) => {
          const data = JSON.parse(e.data) as {
            sessionId: string
            patch?: Partial<AgentSession>
          }
          if (data.patch) {
            patchSession(data.sessionId, data.patch)
          }
          void refreshSessions()
          const selected = useAgentSessionStore.getState().selectedSessionId
          if (data.sessionId === selected) void refreshDetail()
        },
        session_step_completed: (e) => {
          const { sessionId } = JSON.parse(e.data) as { sessionId: string }
          void refreshSessions()
          const selected = useAgentSessionStore.getState().selectedSessionId
          if (sessionId === selected) void refreshDetail()
        },
        session_created: () => void refreshSessions(),
        session_deleted: () => void refreshSessions(),
      },
    })
  }, [refreshSessions, refreshDetail, patchSession])
}
