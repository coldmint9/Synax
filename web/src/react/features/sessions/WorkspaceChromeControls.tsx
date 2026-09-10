import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Bot,
  ChevronDown,
  FileCode2,
  FileDiff,
  LayoutDashboard,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react'
import { useSessionWorkspaceEnvironment } from './SessionEnvironmentContext'
import {
  activateWorkspaceTab,
  openWorkspaceTab,
  showWorkspaceDashboard,
  useSessionWorkspace,
  useSessionWorkspaceStore,
  type WorkspaceTab,
} from './sessionWorkspaceStore'

const MENU_GROUP_LIMIT = 12
const FOCUS_VISIBLE_TABS = 3

function tabIcon(kind: WorkspaceTab['kind']) {
  switch (kind) {
    case 'file': return <FileCode2 size={11} className="shrink-0 text-run/80" />
    case 'diff': return <FileDiff size={11} className="shrink-0 text-success/80" />
    case 'subagent': return <Bot size={11} className="shrink-0 text-[var(--color-run)]/80" />
  }
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function useDismissableMenu(open: boolean, setOpen: (value: boolean) => void) {
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, setOpen])
  return rootRef
}

function MenuItem({
  icon,
  children,
  onClick,
  title,
}: {
  icon: ReactNode
  children: ReactNode
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="workspace-new-tab-item"
      title={title}
      onClick={onClick}
    >
      {icon}
      <span className="workspace-new-tab-label">{children}</span>
    </button>
  )
}

function NewTabMenu({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const rootRef = useDismissableMenu(open, setOpen)
  const { environment, loading } = useSessionWorkspaceEnvironment(sessionId)

  const changed = (environment?.changedFiles ?? []).slice(0, MENU_GROUP_LIMIT)
  const inputs = (environment?.inputFiles ?? []).slice(-MENU_GROUP_LIMIT).reverse()
  const subagents = (environment?.subagents ?? []).slice(0, MENU_GROUP_LIMIT)
  const empty = changed.length === 0 && inputs.length === 0 && subagents.length === 0

  const openAndClose = (tab: Omit<WorkspaceTab, 'id'>) => {
    openWorkspaceTab(sessionId, tab)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        className="workspace-chrome-icon"
        aria-label="新建标签页"
        title="新建标签页"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Plus size={12} />
      </button>

      {open ? (
        <div className="workspace-new-tab-menu workspace-new-tab-menu--chrome" role="menu">
          <MenuItem
            icon={<LayoutDashboard size={11} className="shrink-0 text-primary" />}
            onClick={() => {
              showWorkspaceDashboard(sessionId)
              setOpen(false)
            }}
          >
            工作区面板
          </MenuItem>

          {loading && empty ? (
            <div className="workspace-new-tab-empty">加载中…</div>
          ) : empty ? (
            <div className="workspace-new-tab-empty">该会话暂无可打开的条目</div>
          ) : null}

          {subagents.length > 0 ? (
            <>
              <div className="workspace-new-tab-group">Subagents</div>
              {subagents.map(sub => (
                <MenuItem
                  key={`subagent:${sub.id}`}
                  icon={<Bot size={11} className="shrink-0 text-primary" />}
                  title={sub.prompt}
                  onClick={() => openAndClose({
                    kind: 'subagent',
                    title: sub.title ?? sub.id.slice(0, 8),
                    sessionId: sub.id,
                  })}
                >
                  {sub.title ?? sub.id.slice(0, 8)}
                </MenuItem>
              ))}
            </>
          ) : null}

          {changed.length > 0 ? (
            <>
              <div className="workspace-new-tab-group">Git 变更</div>
              {changed.map(file => (
                <MenuItem
                  key={`diff:${file.path}`}
                  icon={<FileDiff size={11} className="shrink-0 text-success/80" />}
                  title={file.path}
                  onClick={() => openAndClose({
                    kind: 'diff',
                    title: baseName(file.path),
                    path: file.path,
                  })}
                >
                  {file.path}
                </MenuItem>
              ))}
            </>
          ) : null}

          {inputs.length > 0 ? (
            <>
              <div className="workspace-new-tab-group">输入文件</div>
              {inputs.map(path => (
                <MenuItem
                  key={`file:${path}`}
                  icon={<FileCode2 size={11} className="shrink-0 text-run/80" />}
                  title={path}
                  onClick={() => openAndClose({
                    kind: 'file',
                    title: baseName(path),
                    path,
                  })}
                >
                  {path}
                </MenuItem>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function TabSwitcher({
  sessionId,
}: {
  sessionId: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useDismissableMenu(open, setOpen)
  const { tabs, activeTabId } = useSessionWorkspace(sessionId)

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        className="workspace-chrome-icon"
        aria-label="切换工作区标签"
        title="切换工作区标签"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="workspace-new-tab-menu workspace-new-tab-menu--chrome" role="menu">
          <MenuItem
            icon={<LayoutDashboard size={11} className="shrink-0 text-primary" />}
            onClick={() => {
              showWorkspaceDashboard(sessionId)
              setOpen(false)
            }}
          >
            工作区面板
          </MenuItem>
          {tabs.map(tab => (
            <MenuItem
              key={tab.id}
              icon={tabIcon(tab.kind)}
              title={tab.title}
              onClick={() => {
                activateWorkspaceTab(sessionId, tab.id)
                setOpen(false)
              }}
            >
              <span className={tab.id === activeTabId ? 'text-foreground' : undefined}>{tab.title}</span>
            </MenuItem>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function WorkspaceWing({ sessionId }: { sessionId: string | null }) {
  const { tabs, activeTabId } = useSessionWorkspace(sessionId)
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null
  const enterFocus = useSessionWorkspaceStore(state => state.enterFocus)
  const activateTab = useSessionWorkspaceStore(state => state.activateTab)
  const showDashboard = useSessionWorkspaceStore(state => state.showDashboard)

  if (!sessionId) return null

  return (
    <div className="workspace-wing" data-active={activeTab ? 'true' : 'false'}>
      <button
        type="button"
        className="workspace-wing-current"
        aria-label={activeTab ? `聚焦 ${activeTab.title}` : '打开工作区面板'}
        title={activeTab?.title ?? '工作区'}
        onClick={() => {
          if (activeTab) activateTab(sessionId, activeTab.id)
          else showDashboard(sessionId)
          enterFocus(sessionId)
        }}
      >
        {activeTab ? tabIcon(activeTab.kind) : <LayoutDashboard size={11} className="shrink-0 text-primary" />}
        <span className="workspace-wing-label">{activeTab?.title ?? '工作区'}</span>
        {tabs.length > 0 ? <span className="workspace-wing-count">{tabs.length}</span> : null}
      </button>
      {tabs.length > 0 ? <TabSwitcher sessionId={sessionId} /> : null}
      <NewTabMenu sessionId={sessionId} />
    </div>
  )
}

export function WorkspaceFocusControls({ sessionId }: { sessionId: string | null }) {
  const { tabs, activeTabId } = useSessionWorkspace(sessionId)
  const { loading, reload } = useSessionWorkspaceEnvironment(sessionId)
  const activateTab = useSessionWorkspaceStore(state => state.activateTab)
  const closeTab = useSessionWorkspaceStore(state => state.closeTab)
  const closeAll = useSessionWorkspaceStore(state => state.closeAll)
  const showDashboard = useSessionWorkspaceStore(state => state.showDashboard)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const overflowRef = useDismissableMenu(overflowOpen, setOverflowOpen)

  if (!sessionId) return null

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null
  const visibleTabs = tabs.length <= FOCUS_VISIBLE_TABS
    ? tabs
    : activeTab
      ? [activeTab, ...tabs.filter(tab => tab.id !== activeTab.id).slice(0, FOCUS_VISIBLE_TABS - 1)]
      : tabs.slice(0, FOCUS_VISIBLE_TABS)
  const hiddenTabs = tabs.filter(tab => !visibleTabs.some(visible => visible.id === tab.id))

  return (
    <div className="workspace-focus-controls" role="tablist" aria-label="工作区标签">
      <button
        type="button"
        role="tab"
        className={`workspace-focus-home ${activeTab ? '' : 'workspace-focus-home--active'}`}
        aria-selected={!activeTab}
        onClick={() => showDashboard(sessionId)}
      >
        <LayoutDashboard size={11} />
        <span>工作区</span>
      </button>

      {visibleTabs.map((tab) => {
        const active = tab.id === activeTabId
        return (
          <div key={tab.id} className={`workspace-focus-tab ${active ? 'workspace-focus-tab--active' : ''}`}>
            <button
              type="button"
              role="tab"
              className="workspace-focus-tab-main"
              aria-selected={active}
              title={tab.title}
              onClick={() => activateTab(sessionId, tab.id)}
            >
              {tabIcon(tab.kind)}
              <span>{tab.title}</span>
            </button>
            <button
              type="button"
              className="workspace-focus-tab-close"
              aria-label={`关闭 ${tab.title}`}
              title={`关闭 ${tab.title}`}
              onClick={() => closeTab(sessionId, tab.id)}
            >
              <X size={9} />
            </button>
          </div>
        )
      })}

      {hiddenTabs.length > 0 ? (
        <div ref={overflowRef} className="relative shrink-0">
          <button
            type="button"
            className="workspace-focus-overflow"
            aria-label={`还有 ${hiddenTabs.length} 个标签`}
            title={`还有 ${hiddenTabs.length} 个标签`}
            aria-expanded={overflowOpen}
            onClick={() => setOverflowOpen(value => !value)}
          >
            +{hiddenTabs.length}
          </button>
          {overflowOpen ? (
            <div className="workspace-new-tab-menu workspace-new-tab-menu--chrome" role="menu">
              {hiddenTabs.map(tab => (
                <MenuItem
                  key={tab.id}
                  icon={tabIcon(tab.kind)}
                  title={tab.title}
                  onClick={() => {
                    activateTab(sessionId, tab.id)
                    setOverflowOpen(false)
                  }}
                >
                  {tab.title}
                </MenuItem>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <NewTabMenu sessionId={sessionId} />
      <button
        type="button"
        className="workspace-chrome-icon"
        aria-label="刷新工作区"
        title="刷新工作区"
        disabled={loading}
        onClick={() => void reload()}
      >
        <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
      </button>
      {tabs.length > 0 ? (
        <button
          type="button"
          className="workspace-chrome-icon"
          aria-label="关闭全部标签"
          title="关闭全部标签"
          onClick={() => closeAll(sessionId)}
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  )
}
