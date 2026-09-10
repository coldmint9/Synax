import { memo, useEffect, useRef } from 'react'
import { Bot, FileCode2, FileDiff, Maximize2, Minimize2, X } from 'lucide-react'
import { useAgentSessionStore } from './agentSessionStore'
import { useSessionWorkspaceStore, type WorkspaceTab } from './sessionWorkspaceStore'
import { WorkspaceDashboard } from './WorkspaceDashboard'
import { CodeViewer } from './CodeViewer'
import { DiffViewer } from './DiffViewer'
import { SubagentReadonlyView } from './SubagentReadonlyView'

function tabIcon(kind: WorkspaceTab['kind']) {
  switch (kind) {
    case 'file': return <FileCode2 size={11} className="shrink-0 text-sky-400/80" />
    case 'diff': return <FileDiff size={11} className="shrink-0 text-success/80" />
    case 'subagent': return <Bot size={11} className="shrink-0 text-[var(--color-run)]/80" />
  }
}

function ActiveTabContent({ tab, sessionId }: { tab: WorkspaceTab; sessionId: string }) {
  if (tab.kind === 'file' && tab.path) return <CodeViewer sessionId={sessionId} path={tab.path} />
  if (tab.kind === 'diff' && tab.path) return <DiffViewer sessionId={sessionId} path={tab.path} />
  if (tab.kind === 'subagent' && tab.sessionId) return <SubagentReadonlyView sessionId={tab.sessionId} />
  return null
}

export const SessionWorkspacePanel = memo(function SessionWorkspacePanel({
  sessionId,
  maximized,
  onToggleMaximize,
}: {
  sessionId: string | null
  maximized: boolean
  onToggleMaximize: () => void
}) {
  const { tabs, activeTabId, activateTab, closeTab, closeAll, setMaximized, resetTabs } = useSessionWorkspaceStore()
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null
  const lastSessionRef = useRef(sessionId)

  useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      lastSessionRef.current = sessionId
      resetTabs()
    }
  }, [sessionId, resetTabs])

  if (!sessionId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground/60">
        选择会话后使用工作区
      </div>
    )
  }

  if (tabs.length === 0 || !activeTab) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspaceHeader
          maximized={maximized}
          onToggleMaximize={onToggleMaximize}
          showCloseAll={false}
        />
        <WorkspaceDashboard sessionId={sessionId} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-1.5 py-1.5">
        <div className="workspace-tab-list flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map(tab => {
            const active = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                className={`workspace-tab group flex min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] ${active ? 'workspace-tab--active' : 'text-muted-foreground hover:bg-secondary/50'}`}
                onClick={() => activateTab(tab.id)}
              >
                {tabIcon(tab.kind)}
                <span className="max-w-28 truncate" title={tab.title}>{tab.title}</span>
                <button
                  type="button"
                  className="inline-flex size-3.5 items-center justify-center rounded opacity-0 transition group-hover:opacity-100 hover:bg-secondary"
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                  aria-label="关闭标签"
                >
                  <X size={10} />
                </button>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          onClick={closeAll}
          aria-label="关闭全部标签"
          title="关闭全部标签"
        >
          <X size={12} />
        </button>
        <button
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          onClick={() => { onToggleMaximize(); setMaximized(!maximized) }}
          aria-label={maximized ? '还原工作区' : '最大化工作区'}
          title={maximized ? '还原工作区' : '最大化工作区'}
        >
          {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      </div>
      <ActiveTabContent tab={activeTab} sessionId={sessionId} />
    </div>
  )
})

function WorkspaceHeader({
  maximized,
  onToggleMaximize,
  showCloseAll,
}: {
  maximized: boolean
  onToggleMaximize: () => void
  showCloseAll: boolean
}) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border/40 px-1.5 py-1">
      {showCloseAll && (
        <button type="button" className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60" aria-label="关闭全部标签">
          <X size={12} />
        </button>
      )}
      <button
        type="button"
        className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
        onClick={onToggleMaximize}
        aria-label={maximized ? '还原工作区' : '最大化工作区'}
        title={maximized ? '还原工作区' : '最大化工作区'}
      >
        {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
      </button>
    </div>
  )
}
