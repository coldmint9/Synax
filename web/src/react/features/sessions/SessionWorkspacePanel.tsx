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
  mode = 'auto',
}: {
  sessionId: string | null
  /** `dashboard` keeps the sidecar cards visible; `content` renders only the active tab. */
  mode?: 'auto' | 'dashboard' | 'content'
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

  if (mode === 'content' && !activeTab) return null

  return (
    <div
      className={`session-workspace-panel session-workspace-panel--${mode === 'auto' ? presentation : mode}`}
      data-workspace-presentation={presentation}
    >
      {mode === 'dashboard' || !activeTab ? (
        <WorkspaceDashboard
          sessionId={sessionId}
          environment={environment}
          loading={loading}
          reload={reload}
        />
      ) : (
        <ActiveTabContent tab={activeTab} sessionId={sessionId} />
      )}
    </div>
  )
})
