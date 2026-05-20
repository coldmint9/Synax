import { useEffect, useRef } from 'react'
import { useDebugConsole } from './debugConsoleStore'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

export function useRuntimeSSE() {
  const refreshSessions = useDebugConsole(s => s.refreshSessions)
  const refreshDetail = useDebugConsole(s => s.refreshDetail)
  const retriesRef = useRef(0)

  useEffect(() => {
    let es: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    function connect() {
      if (disposed) return
      es = new EventSource('/api/agent-runtime/events/stream')

      es.addEventListener('connected', () => {
        retriesRef.current = 0
        void refreshSessions()
      })

      es.addEventListener('session_changed', (e) => {
        const { sessionId } = JSON.parse(e.data)
        void refreshSessions()
        const selected = useDebugConsole.getState().selectedSessionId
        if (sessionId === selected) {
          void refreshDetail()
        }
      })

      es.addEventListener('session_created', () => void refreshSessions())
      es.addEventListener('session_deleted', () => void refreshSessions())

      es.onerror = () => {
        es?.close()
        scheduleReconnect()
      }
    }

    function scheduleReconnect() {
      if (disposed) return
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** retriesRef.current,
        RECONNECT_MAX_MS,
      )
      retriesRef.current++
      reconnectTimer = setTimeout(connect, delay)
    }

    connect()

    return () => {
      disposed = true
      es?.close()
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [refreshSessions, refreshDetail])
}
