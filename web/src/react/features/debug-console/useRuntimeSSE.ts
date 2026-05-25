import { useEffect } from 'react'
import { useDebugConsole } from './debugConsoleStore'
import { subscribe } from '../../../lib/api/runtimeEventBus'

export function useRuntimeSSE() {
  const refreshSessions = useDebugConsole(s => s.refreshSessions)
  const refreshDetail = useDebugConsole(s => s.refreshDetail)

  useEffect(() => {
    return subscribe({
      onConnect: () => void refreshSessions(),
      events: {
        session_changed: (e) => {
          const { sessionId } = JSON.parse(e.data)
          void refreshSessions()
          const selected = useDebugConsole.getState().selectedSessionId
          if (sessionId === selected) void refreshDetail()
        },
        session_step_completed: (e) => {
          const { sessionId } = JSON.parse(e.data)
          const selected = useDebugConsole.getState().selectedSessionId
          if (sessionId === selected) void refreshDetail()
        },
        session_created: () => void refreshSessions(),
        session_deleted: () => void refreshSessions(),
      },
    })
  }, [refreshSessions, refreshDetail])
}
