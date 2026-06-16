import { memo } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useDebugConsole } from '../features/debug-console/debugConsoleStore'
import { useDebugPolling } from '../features/debug-console/useDebugPolling'
import { useSessionLiveStream } from '../features/debug-console/useSessionLiveStream'
import { SessionTranscript } from '../features/sessions/SessionTranscript'
import { SessionWorkspace } from '../features/sessions/SessionWorkspace'
import { SessionListPanel } from '../features/sessions/SessionListPanel'
import type { SessionListView } from '../features/sessions/sessionBuckets'

export default memo(function SessionsPage() {
  useDebugPolling()
  const { projectId = '' } = useParams()
  const location = useLocation()
  const listView: SessionListView = location.pathname.includes('/sessions/workflows') ? 'workflow' : 'goal'

  const agentSessionId = useDebugConsole(s => s.selectedSessionId)
  const agentPanelOpen = useDebugConsole(s => s.panelOpen)

  useSessionLiveStream(agentPanelOpen ? agentSessionId : null)

  const showTranscript = agentPanelOpen && agentSessionId

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[260px] shrink-0 border-r border-border/40 overflow-hidden">
        <SessionListPanel listView={listView} projectId={projectId} />
      </aside>

      {showTranscript ? (
        <>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <SessionTranscript />
          </div>
          <aside className="w-[220px] shrink-0 border-l border-border/40 bg-background/50">
            <SessionWorkspace />
          </aside>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          选择一个会话查看详情
        </div>
      )}
    </div>
  )
})
