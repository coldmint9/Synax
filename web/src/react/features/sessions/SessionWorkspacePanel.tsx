import { memo } from 'react'
import { useSessionWorkspaceEnvironment } from './SessionEnvironmentContext'
import { useSessionWorkspace, type WorkspaceTab } from './sessionWorkspaceStore'
import { WorkspaceDashboard } from './WorkspaceDashboard'
import { CodeViewer } from './CodeViewer'
import { DiffViewer } from './DiffViewer'
import { SubagentReadonlyView } from './SubagentReadonlyView'

function ActiveTabContent({ tab, sessionId }: { tab: WorkspaceTab; sessionId: string }) {
  if (tab.kind === 'file' && tab.path) return <CodeViewer sessionId={sessionId} path={tab.path} />
  if (tab.kind === 'diff' && tab.path) return <DiffViewer sessionId={sessionId} path={tab.path} />
  if (tab.kind === 'subagent' && tab.sessionId) return <SubagentReadonlyView sessionId={tab.sessionId} />
  return null
}

export const SessionWorkspacePanel = memo(function SessionWorkspacePanel({
  sessionId,
}: {
  sessionId: string | null
}) {
  const { tabs, activeTabId, presentation } = useSessionWorkspace(sessionId)
  const { environment, loading, reload } = useSessionWorkspaceEnvironment(sessionId)
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null

  if (!sessionId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground/60">
        选择会话后使用工作区
      </div>
    )
  }

  return (
    <div
      className={`session-workspace-panel session-workspace-panel--${presentation}`}
      data-workspace-presentation={presentation}
    >
      {activeTab ? (
        <ActiveTabContent tab={activeTab} sessionId={sessionId} />
      ) : (
        <WorkspaceDashboard
          sessionId={sessionId}
          environment={environment}
          loading={loading}
          reload={reload}
        />
      )}
    </div>
  )
})
