import { useContextStore } from '../state/contextStore'
import { useDebugConsole } from '../features/debug-console/debugConsoleStore'
import { useDebugPolling } from '../features/debug-console/useDebugPolling'
import { useSessionLiveStream } from '../features/debug-console/useSessionLiveStream'
import { SessionTranscript } from '../features/sessions/SessionTranscript'
import { SessionWorkspace, useHasWorkspaceContent } from '../features/sessions/SessionWorkspace'
import SessionList from '../features/coordinates/context/SessionList'

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

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧会话列表 */}
      <aside className="w-[220px] shrink-0 border-r border-border/40 overflow-hidden">
        <SessionList />
      </aside>

      {/* 主内容区 */}
      {mode ? (
        <>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <SessionTranscript mode={mode} />
          </div>
          {hasContent && (
            <aside className="w-[220px] shrink-0 border-l border-border/40 bg-background/50">
              <SessionWorkspace mode={mode} />
            </aside>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          选择一个会话查看详情
        </div>
      )}
    </div>
  )
}

