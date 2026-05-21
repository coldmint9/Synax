import { useContextStore } from '../state/contextStore'
import { useDebugConsole } from '../features/debug-console/debugConsoleStore'
import { useDebugPolling } from '../features/debug-console/useDebugPolling'
import { useSessionLiveStream } from '../features/debug-console/useSessionLiveStream'
import { SessionTranscript } from '../features/sessions/SessionTranscript'
import { SessionWorkspace, useHasWorkspaceContent } from '../features/sessions/SessionWorkspace'

export default function SessionsPage() {
  useDebugPolling()
  const currentSessionId = useContextStore(s => s.currentSessionId)
  const agentSessionId = useDebugConsole(s => s.selectedSessionId)
  const agentPanelOpen = useDebugConsole(s => s.panelOpen)

  useSessionLiveStream(agentPanelOpen ? agentSessionId : null)

  const mode: 'context' | 'agent' | null =
    agentPanelOpen && agentSessionId ? 'agent'
    : currentSessionId ? 'context'
    : null

  const hasContent = useHasWorkspaceContent(mode ?? 'context')

  if (!mode) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        从左侧选择一个会话查看详情
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <SessionTranscript mode={mode} />
      </div>
      {hasContent && (
        <aside className="w-[220px] shrink-0 border-l border-border/40 bg-background/50">
          <SessionWorkspace mode={mode} />
        </aside>
      )}
    </div>
  )
}
