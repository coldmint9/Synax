import { useEffect } from 'react'
import { useDebugConsole } from './debugConsoleStore'

export function useDebugPolling() {
  const refreshDetail = useDebugConsole(s => s.refreshDetail)
  const panelOpen = useDebugConsole(s => s.panelOpen)
  const selectedSessionId = useDebugConsole(s => s.selectedSessionId)

  useEffect(() => {
    if (!panelOpen || !selectedSessionId) return
    void refreshDetail()
  }, [panelOpen, selectedSessionId, refreshDetail])
}
