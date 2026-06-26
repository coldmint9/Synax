import { useEffect } from 'react'
import { useAgentSessionStore } from './agentSessionStore'
import { subscribe } from '../../../lib/api/runtimeEventBus'
import type { AgentSession } from '../../../lib/api/agentRuntime'

function isTitleOnlyPatch(patch: Partial<AgentSession>): patch is { title: string } {
  const keys = Object.keys(patch)
  return keys.length === 1 && keys[0] === 'title' && typeof patch.title === 'string'
}

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
          if (!data.patch) {
            void refreshSessions()
            return
          }

          const patched = patchSession(data.sessionId, data.patch)
          const titleOnly = isTitleOnlyPatch(data.patch)
          if (!patched || !titleOnly) {
            void refreshSessions()
          }
          const selected = useAgentSessionStore.getState().selectedSessionId
          if (data.sessionId === selected && !titleOnly) {
            void refreshDetail()
          }
        },
        session_step_completed: (e) => {
          const { sessionId } = JSON.parse(e.data) as { sessionId: string }
          void refreshSessions()
          const selected = useAgentSessionStore.getState().selectedSessionId
          if (sessionId === selected) void refreshDetail()
        },
        session_input_queue_changed: (e) => {
          const { sessionId } = JSON.parse(e.data) as { sessionId: string }
          void useAgentSessionStore.getState().loadInputQueue(sessionId)
        },
        session_created: () => void refreshSessions(),
        session_deleted: () => void refreshSessions(),
      },
    })
  }, [refreshSessions, refreshDetail, patchSession])
}
