import { useEffect } from 'react'
import { useDebugConsole } from './debugConsoleStore'

export function useDebugPolling() {
  const refreshSessions = useDebugConsole(s => s.refreshSessions)
  const refreshDetail = useDebugConsole(s => s.refreshDetail)
  const panelOpen = useDebugConsole(s => s.panelOpen)
  const selectedSessionId = useDebugConsole(s => s.selectedSessionId)

  useEffect(() => {
    void refreshSessions()
    const timer = window.setInterval(() => void refreshSessions(), 5000)
    return () => window.clearInterval(timer)
  }, [refreshSessions])

  useEffect(() => {
    if (!panelOpen || !selectedSessionId) return
    void refreshDetail()
    const timer = window.setInterval(() => void refreshDetail(), 2000)
    return () => window.clearInterval(timer)
  }, [panelOpen, selectedSessionId, refreshDetail])
}
