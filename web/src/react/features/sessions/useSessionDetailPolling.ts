import { useEffect } from 'react'
import { useAgentSessionStore } from './agentSessionStore'

export function useSessionDetailPolling() {
  const refreshDetail = useAgentSessionStore(s => s.refreshDetail)
  const panelOpen = useAgentSessionStore(s => s.panelOpen)
  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)

  useEffect(() => {
    if (!panelOpen || !selectedSessionId) return
    void refreshDetail()
  }, [panelOpen, selectedSessionId, refreshDetail])
}
