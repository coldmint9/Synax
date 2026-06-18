import { useEffect } from 'react'
import { useAgentSessionStore } from './agentSessionStore'

const ACTIVE_SESSION_POLL_MS = 4_000

/** Poll session list + detail while the selected session is actively running. */
export function useSessionDetailPolling() {
  const refreshDetail = useAgentSessionStore(s => s.refreshDetail)
  const refreshSessions = useAgentSessionStore(s => s.refreshSessions)
  const panelOpen = useAgentSessionStore(s => s.panelOpen)
  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)
  const selectedStatus = useAgentSessionStore(s => {
    const id = s.selectedSessionId
    return id ? s.sessions.find(sess => sess.id === id)?.status : undefined
  })

  useEffect(() => {
    if (!panelOpen || !selectedSessionId) return
    const isActive = selectedStatus === 'running' || selectedStatus === 'waiting_permission'
    if (!isActive) return

    const refresh = () => {
      void refreshSessions()
      void refreshDetail()
    }

    refresh()
    const timer = window.setInterval(refresh, ACTIVE_SESSION_POLL_MS)

    return () => window.clearInterval(timer)
  }, [panelOpen, selectedSessionId, selectedStatus, refreshDetail, refreshSessions])
}
