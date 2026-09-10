import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Bot,
  ChevronDown,
  FileCode2,
  FileDiff,
  RefreshCw,
  X,
} from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { useSessionWorkspaceEnvironment } from './SessionEnvironmentContext'
import {
  activateWorkspaceTab,
  useSessionWorkspace,
  useSessionWorkspaceStore,
  type WorkspaceTab,
} from './sessionWorkspaceStore'

const FOCUS_VISIBLE_TABS = 3

function tabIcon(kind: WorkspaceTab['kind']) {
  switch (kind) {
    case 'file': return <FileCode2 size={11} className="shrink-0 text-run/80" />
    case 'diff': return <FileDiff size={11} className="shrink-0 text-success/80" />
    case 'subagent': return <Bot size={11} className="shrink-0 text-[var(--color-run)]/80" />
  }
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

function TabSwitcher({
  sessionId,
}: {
  sessionId: string
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const rootRef = useDismissableMenu(open, setOpen)
  const { tabs, activeTabId } = useSessionWorkspace(sessionId)

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        className="workspace-chrome-icon"
        aria-label={t('workspaceSwitchTab')}
        title={t('workspaceSwitchTab')}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="workspace-new-tab-menu workspace-new-tab-menu--chrome" role="menu">
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
  const { t } = useLocale()
  const { tabs, activeTabId } = useSessionWorkspace(sessionId)
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0] ?? null
  const activateTab = useSessionWorkspaceStore(state => state.activateTab)

  if (!sessionId || !activeTab) return null

  return (
    <div className="workspace-wing" data-active={activeTab ? 'true' : 'false'}>
      <button
        type="button"
        className="workspace-wing-current"
        aria-label={t('workspaceActivateTab', { title: activeTab.title })}
        title={activeTab.title}
        onClick={() => activateTab(sessionId, activeTab.id)}
      >
        {tabIcon(activeTab.kind)}
        <span className="workspace-wing-label">{activeTab.title}</span>
        <span className="workspace-wing-count">{tabs.length}</span>
      </button>
      {tabs.length > 1 ? <TabSwitcher sessionId={sessionId} /> : null}
    </div>
  )
}

export function WorkspaceFocusControls({ sessionId }: { sessionId: string | null }) {
  const { t } = useLocale()
  const { tabs, activeTabId } = useSessionWorkspace(sessionId)
  const { loading, reload } = useSessionWorkspaceEnvironment(sessionId)
  const activateTab = useSessionWorkspaceStore(state => state.activateTab)
  const closeTab = useSessionWorkspaceStore(state => state.closeTab)
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
    <div className="workspace-focus-controls" role="tablist" aria-label={t('workspaceTabsLabel')}>
      <div className="workspace-tabs-pill">
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
                aria-label={t('workspaceCloseTab', { title: tab.title })}
                title={t('workspaceCloseTab', { title: tab.title })}
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
              aria-label={t('workspaceMoreTabs', { count: hiddenTabs.length })}
              title={t('workspaceMoreTabs', { count: hiddenTabs.length })}
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
      </div>

      <button
        type="button"
        className="workspace-chrome-icon"
        aria-label={t('workspaceRefresh')}
        title={t('workspaceRefresh')}
        disabled={loading}
        onClick={() => void reload()}
      >
        <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  )
}
