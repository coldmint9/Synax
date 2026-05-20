import { useEffect } from 'react'
import { useDebugConsole } from './debugConsoleStore'
import { useRuntimeSSE } from './useRuntimeSSE'

export function useDebugPolling() {
  const refreshSessions = useDebugConsole(s => s.refreshSessions)
  const refreshDetail = useDebugConsole(s => s.refreshDetail)
  const panelOpen = useDebugConsole(s => s.panelOpen)
  const selectedSessionId = useDebugConsole(s => s.selectedSessionId)

  // SSE 驱动实时更新
  useRuntimeSSE()

  // 初始加载 session 列表
  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  // 选中 session 时加载详情
  useEffect(() => {
    if (!panelOpen || !selectedSessionId) return
    void refreshDetail()
  }, [panelOpen, selectedSessionId, refreshDetail])
}
