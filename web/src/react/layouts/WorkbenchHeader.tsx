import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { Tabs, Dropdown, Modal, Button, useOverlayState } from '@heroui/react'
import { ArrowLeft, BookOpen, Bot, Search, Settings2, Sun, Moon, Plus, Trash2, BookDashed, Ellipsis, Download, RotateCcw, Minimize2 } from 'lucide-react'
import { useShellStore, type ProjectSummary } from '../state/shellStore'
import { useWikiStore, type WikiViewMode } from '../state/wikiStore'
import { useLocale } from '../../hooks/useLocale'
import { wikiApi } from '../../lib/api/wiki'
import { NotificationBell } from '../components/notifications/NotificationBell'
import { useAgentSessionStore } from '../features/sessions/agentSessionStore'
import { getSessionDisplayTitle } from '../features/sessions/useSessionDisplayTitle'
import { useSessionWorkspace, useSessionWorkspaceStore } from '../features/sessions/sessionWorkspaceStore'
import { WorkspaceFocusControls, WorkspaceWing } from '../features/sessions/WorkspaceChromeControls'
import WikiSearchPanel from '../features/wiki/WikiSearchPanel'
import { useWikiSearch, type SearchResult } from '../features/wiki/WikiSearchPanel'
import type { ActivityPanel } from './ActivityBar'

export type ChromeMode = 'global' | 'agentDock' | 'workspaceFocus'

interface WorkbenchHeaderProps {
  chromeMode: ChromeMode
  activePanel: ActivityPanel | null
  onPanelToggle: (panel: ActivityPanel) => void
  hasProject: boolean
  projectName: string
  currentProjectId: string
  projects: ProjectSummary[]
  onProjectSwitch: (projectId: string) => void
  onCreateProject: () => void
  onRemoveProject: (projectId: string) => Promise<void>
}

const navTabs: { id: ActivityPanel; icon: typeof BookOpen; label: string }[] = [
  { id: 'sessions', icon: Bot, label: 'Work' },
  { id: 'wiki', icon: BookOpen, label: 'Wiki' },
]

function ProjectSwitcher({
  hasProject,
  projectName,
  currentProjectId,
  projects,
  onProjectSwitch,
  onCreateProject,
  onRemoveRequest,
  compact = false,
}: {
  hasProject: boolean
  projectName: string
  currentProjectId: string
  projects: ProjectSummary[]
  onProjectSwitch: (projectId: string) => void
  onCreateProject: () => void
  onRemoveRequest: (event: React.MouseEvent, project: ProjectSummary) => void
  compact?: boolean
}) {
  const { t } = useLocale()
  const labelRef = useRef<HTMLSpanElement>(null)
  const displayName = hasProject ? projectName : 'Synax'

  return (
    <Dropdown>
      <Dropdown.Trigger>
        <div
          role="button"
          tabIndex={0}
          className={`wh-project-trigger ${compact ? 'wh-project-trigger--compact' : ''}`}
          title={displayName}
        >
          <span
            ref={labelRef}
            className="wh-project-label text-xs font-medium"
            onMouseEnter={() => labelRef.current?.scrollTo({ left: labelRef.current.scrollWidth, behavior: 'smooth' })}
            onMouseLeave={() => labelRef.current?.scrollTo({ left: 0, behavior: 'smooth' })}
          >
            {displayName}
          </span>
        </div>
      </Dropdown.Trigger>
      <Dropdown.Popover placement={compact ? 'bottom start' : 'top start'}>
        <Dropdown.Menu
          aria-label={t('appSwitchProject')}
          onAction={(key) => {
            if (key === '__create__') onCreateProject()
            else onProjectSwitch(key as string)
          }}
        >
          {projects.map(project => (
            <Dropdown.Item key={project.id} id={project.id} textValue={project.name}>
              <div className="flex items-center justify-between w-full gap-2">
                <span className="text-xs truncate">{project.name}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition cursor-pointer"
                  onClick={(event) => onRemoveRequest(event, project)}
                >
                  <Trash2 size={11} />
                </span>
              </div>
            </Dropdown.Item>
          ))}
          <Dropdown.Item key="__create__" id="__create__" textValue={t('appImportProject')}>
            <span className="flex items-center gap-1.5 text-xs text-primary">
              <Plus size={12} />
              {t('appImportProject')}
            </span>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

function WikiToolbar() {
  const { t } = useLocale()
  const viewMode = useWikiStore(s => s.viewMode)
  const setViewMode = useWikiStore(s => s.setViewMode)
  const draftsReady = useWikiStore(s => s.draftsSummary.ready)
  const draftsGenerating = useWikiStore(s => s.draftsSummary.generating)
  const toggleDraftPanel = useWikiStore(s => s.toggleDraftPanel)
  const draftPanelOpen = useWikiStore(s => s.draftPanelOpen)
  const planGenStatus = useWikiStore(s => s.planGeneration.status)
  const snapshot = useWikiStore(s => s.snapshot)
  const selectDocument = useWikiStore(s => s.selectDocument)
  const setSearchHighlightQuery = useWikiStore(s => s.setSearchHighlightQuery)

  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { results } = useWikiSearch(query)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearching(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    if (searching) inputRef.current?.focus()
  }, [searching])

  useEffect(() => { setActiveIndex(0) }, [results])

  function handleSelect(result: SearchResult) {
    setViewMode('document')
    selectDocument(result.documentId)
    setSearchHighlightQuery(query.trim())
    closeSearch()
  }

  function closeSearch() {
    setSearching(false)
    setQuery('')
    setActiveIndex(0)
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault()
      handleSelect(results[activeIndex])
    }
  }

  if (searching) {
    return (
      <div data-searching className="relative">
        <div className="flex items-center gap-0.5">
          <div className="wh-btn !w-auto !px-2 gap-1.5 !cursor-text" onClick={() => inputRef.current?.focus()}>
            <Search size={13} className="text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('wikiSearchPlaceholder')}
              className="w-[140px] bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <button type="button" className="wh-btn" title="Close" onMouseDown={e => { e.preventDefault(); closeSearch() }}>
            <kbd className="text-[9px] text-muted-foreground">ESC</kbd>
          </button>
        </div>
        {query.trim() && (
          <>
            <div className="fixed inset-0 z-[9998]" onClick={closeSearch} />
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-[9999] w-[360px] rounded-xl border border-border/40 bg-card shadow-2xl overflow-hidden">
              <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 border-l border-t border-border/40 bg-card" />
              <WikiSearchPanel
                query={query}
                activeIndex={activeIndex}
                onActiveIndexChange={setActiveIndex}
                onSelect={handleSelect}
              />
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-0.5">
      <Tabs
        selectedKey={viewMode}
        onSelectionChange={(key) => setViewMode(key as WikiViewMode)}
        className="wiki-view-tabs"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="Wiki" className="wiki-view-tabs-list">
            <Tabs.Tab id="document" className="wiki-view-tab">
              <span>{t('wikiDocument')}</span>
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="plan" className="wiki-view-tab">
              <span>{t('wikiPlan')}</span>
              {planGenStatus === 'generating' && (
                <span className="relative flex h-2 w-2 ml-0.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
              )}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
      <div className="wh-divider" />
      <button type="button" className={`wh-btn relative ${draftPanelOpen ? 'active' : ''}`} title="Drafts" onClick={toggleDraftPanel}>
        <BookDashed size={13} />
        {draftsReady > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-bold text-primary-foreground">
            {draftsReady}
          </span>
        )}
        {draftsGenerating > 0 && draftsReady === 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-primary" />
        )}
      </button>
      <button type="button" className="wh-btn" title={t('appSearch')} onClick={() => setSearching(true)}>
        <Search size={13} />
      </button>
      <Dropdown>
        <Dropdown.Trigger>
          <div role="button" tabIndex={0} className="wh-btn" title="Tools">
            <Ellipsis size={13} />
          </div>
        </Dropdown.Trigger>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label={t('wikiTools')}
            onAction={(key) => {
              if (key === 'export' && snapshot) {
                window.open(wikiApi.exportSnapshotUrl(snapshot.id), '_blank')
              } else if (key === 'reinit') {
                useWikiStore.getState().setShowReinitConfirm(true)
              }
            }}
          >
            <Dropdown.Item key="export" id="export" textValue={t('wikiExportAll')}>
              <span className="flex items-center gap-2 text-xs">
                <Download size={12} />
                {t('wikiExportAll')}
              </span>
            </Dropdown.Item>
            <Dropdown.Item key="reinit" id="reinit" textValue={t('wikiReinitialize')}>
              <span className="flex items-center gap-2 text-xs text-destructive">
                <RotateCcw size={12} />
                {t('wikiReinitialize')}
              </span>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  )
}

function AgentToolbarPill({ visible }: { visible: boolean }) {
  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)
  const { tabs } = useSessionWorkspace(selectedSessionId)

  return (
    <ToolbarPill visible={visible && tabs.length > 0} allowOverflow>
      <WorkspaceWing sessionId={selectedSessionId} />
    </ToolbarPill>
  )
}

function WikiToolbarPill({ visible }: { visible: boolean }) {
  return (
    <ToolbarPill visible={visible}>
      <WikiToolbar />
    </ToolbarPill>
  )
}

function ToolbarPill({
  visible,
  children,
  allowOverflow = false,
}: {
  visible: boolean
  children: ReactNode
  allowOverflow?: boolean
}) {
  const [mounted, setMounted] = useState(false)
  const [phase, setPhase] = useState<'enter' | 'exit' | ''>('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (visible) {
      setMounted(true)
      requestAnimationFrame(() => setPhase('enter'))
    } else if (mounted) {
      setPhase('exit')
      const el = ref.current
      const onEnd = () => { setMounted(false); setPhase('') }
      if (el) {
        el.addEventListener('transitionend', onEnd, { once: true })
        return () => el.removeEventListener('transitionend', onEnd)
      }
      setTimeout(onEnd, 400)
    }
  }, [visible])

  if (!mounted) return null

  const slotClass = `wh-pill-slot ${phase === 'enter' ? 'open' : phase === 'exit' ? 'closing' : ''}`
  const pillClass = `wh-pill ${allowOverflow ? 'wh-pill--overflow-visible' : ''} ${phase === 'enter' ? 'wh-pill-enter' : phase === 'exit' ? 'wh-pill-exit' : ''}`

  return (
    <div ref={ref} className={slotClass}>
      <div className={pillClass}>
        {children}
      </div>
    </div>
  )
}

function FocusGlobalMenu({
  onPanelToggle,
}: {
  onPanelToggle: (panel: ActivityPanel) => void
}) {
  const { t } = useLocale()
  const theme = useShellStore(s => s.preferences.theme)
  const setTheme = useShellStore(s => s.setTheme)

  return (
    <Dropdown>
      <Dropdown.Trigger>
        <span role="button" tabIndex={0} className="workspace-chrome-icon" aria-label={t('projectMoreActions')} title={t('projectMoreActions')}>
          <Ellipsis size={13} />
        </span>
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={t('projectMoreActions')}
          onAction={(key) => {
            if (key === 'agent') onPanelToggle('sessions')
            if (key === 'wiki') onPanelToggle('wiki')
            if (key === 'settings') onPanelToggle('settings')
            if (key === 'theme') setTheme(theme === 'dark' ? 'light' : 'dark')
          }}
        >
          <Dropdown.Item id="agent" textValue={t('titlebarAgent')}>
            <span className="flex items-center gap-2 text-xs"><Bot size={12} />{t('titlebarAgent')}</span>
          </Dropdown.Item>
          <Dropdown.Item id="wiki" textValue="Wiki">
            <span className="flex items-center gap-2 text-xs"><BookOpen size={12} />Wiki</span>
          </Dropdown.Item>
          <Dropdown.Item id="settings" textValue={t('appSettings')}>
            <span className="flex items-center gap-2 text-xs"><Settings2 size={12} />{t('appSettings')}</span>
          </Dropdown.Item>
          <Dropdown.Item id="theme" textValue={theme === 'dark' ? t('appLightMode') : t('appDarkMode')}>
            <span className="flex items-center gap-2 text-xs">
              {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
              {theme === 'dark' ? t('appLightMode') : t('appDarkMode')}
            </span>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

function WorkspaceFocusRail({
  projectName,
  hasProject,
  currentProjectId,
  projects,
  onProjectSwitch,
  onCreateProject,
  onRemoveRequest,
  onPanelToggle,
}: {
  projectName: string
  hasProject: boolean
  currentProjectId: string
  projects: ProjectSummary[]
  onProjectSwitch: (projectId: string) => void
  onCreateProject: () => void
  onRemoveRequest: (event: React.MouseEvent, project: ProjectSummary) => void
  onPanelToggle: (panel: ActivityPanel) => void
}) {
  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)
  const { t } = useLocale()
  const selectedSession = useAgentSessionStore(s => (
    selectedSessionId ? s.sessions.find(session => session.id === selectedSessionId) : undefined
  ))
  const exitFocus = useSessionWorkspaceStore(s => s.exitFocus)
  const sessionTitle = selectedSession ? getSessionDisplayTitle(selectedSession, t('sessionFallbackTitle')) : t('sessionFallbackTitle')

  if (!selectedSessionId) return null

  return (
    <div className="wh-pill wh-pill--focus">
      <button
        type="button"
        className="workspace-focus-origin"
        aria-label={t('workspaceBackToChat')}
        title={t('workspaceBackToChatTitle')}
        onClick={() => exitFocus(selectedSessionId)}
      >
        <ArrowLeft size={12} />
        <span>{t('workspaceChat')}</span>
      </button>

      <div className="workspace-focus-session" title={`${projectName} / ${sessionTitle}`}>
        <span className="workspace-focus-project">{projectName}</span>
        <span className="workspace-focus-separator">/</span>
        <span className="workspace-focus-title">{sessionTitle}</span>
      </div>

      <WorkspaceFocusControls sessionId={selectedSessionId} />

      <div className="workspace-focus-globals">
        <ProjectSwitcher
          compact
          hasProject={hasProject}
          projectName={projectName}
          currentProjectId={currentProjectId}
          projects={projects}
          onProjectSwitch={onProjectSwitch}
          onCreateProject={onCreateProject}
          onRemoveRequest={onRemoveRequest}
        />
        <FocusGlobalMenu onPanelToggle={onPanelToggle} />
        <button
          type="button"
          className="workspace-chrome-icon"
          aria-label={t('workspaceRestore')}
          title={t('workspaceRestore')}
          onClick={() => exitFocus(selectedSessionId)}
        >
          <Minimize2 size={12} />
        </button>
      </div>
    </div>
  )
}

export function WorkbenchHeader({
  chromeMode,
  activePanel,
  onPanelToggle,
  hasProject,
  projectName,
  currentProjectId,
  projects,
  onProjectSwitch,
  onCreateProject,
  onRemoveProject,
}: WorkbenchHeaderProps) {
  const { t } = useLocale()
  const theme = useShellStore(s => s.preferences.theme)
  const setTheme = useShellStore(s => s.setTheme)
  const confirmState = useOverlayState()
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const handleRemoveClick = useCallback((e: React.MouseEvent, project: ProjectSummary) => {
    e.stopPropagation()
    setDeleteTarget(project)
    confirmState.open()
  }, [confirmState])

  const handleConfirmRemove = useCallback(async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await onRemoveProject(deleteTarget.id)
      confirmState.close()
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleting, onRemoveProject, confirmState])

  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)
  useEffect(() => {
    if (chromeMode !== 'workspaceFocus' || !selectedSessionId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]')) return
      if (document.querySelector('[role="dialog"]')) return
      useSessionWorkspaceStore.getState().exitFocus(selectedSessionId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [chromeMode, selectedSessionId])

  const headerClass = `workbench-header ${
    chromeMode === 'workspaceFocus'
      ? 'workbench-header--workspace-focus'
      : chromeMode === 'agentDock'
        ? 'workbench-header--agent-dock'
        : 'workbench-header--global'
  }`

  return (
    <div className={headerClass}>
      {chromeMode === 'workspaceFocus' ? (
        <WorkspaceFocusRail
          projectName={projectName}
          hasProject={hasProject}
          currentProjectId={currentProjectId}
          projects={projects}
          onProjectSwitch={onProjectSwitch}
          onCreateProject={onCreateProject}
          onRemoveRequest={handleRemoveClick}
          onPanelToggle={onPanelToggle}
        />
      ) : (
        <>
          <div className="wh-pill">
            <ProjectSwitcher
              hasProject={hasProject}
              projectName={projectName}
              currentProjectId={currentProjectId}
              projects={projects}
              onProjectSwitch={onProjectSwitch}
              onCreateProject={onCreateProject}
              onRemoveRequest={handleRemoveClick}
            />

            <div className="wh-divider" />

            <Tabs
              selectedKey={activePanel ?? ''}
              onSelectionChange={(key) => onPanelToggle(key as ActivityPanel)}
              className="wh-tabs"
            >
              <Tabs.ListContainer>
                <Tabs.List aria-label={t('workspaceMainNav')} className="wh-tabs-list">
                  {navTabs.map((tab, i) => {
                    const Icon = tab.icon
                    const label = tab.label
                    return (
                      <Tabs.Tab
                        key={tab.id}
                        id={tab.id}
                        isDisabled={!hasProject}
                        className={`wh-tab wh-tab--${tab.id}`}
                      >
                        {i > 0 && <Tabs.Separator />}
                        <Icon size={13} />
                        <span>{label}</span>
                        <Tabs.Indicator />
                      </Tabs.Tab>
                    )
                  })}
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>

            <div className="wh-divider" />

            <div className="wh-actions">
              <NotificationBell />
              <button type="button" className="wh-btn" title={t('appSettings')} onClick={() => onPanelToggle('settings')}>
                <Settings2 size={15} />
              </button>
              <button
                type="button"
                className="wh-btn"
                title={theme === 'dark' ? t('appLightMode') : t('appDarkMode')}
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
              </button>
            </div>
          </div>

          <WikiToolbarPill visible={activePanel === 'wiki'} />
          <AgentToolbarPill visible={activePanel === 'sessions'} />
        </>
      )}

      {/* Remove project confirmation modal */}
      <Modal state={confirmState}>
        <Modal.Backdrop>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Icon className="bg-destructive/10 text-destructive">
                  <Trash2 size={18} />
                </Modal.Icon>
                <Modal.Heading>{t('appRemoveProject')}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm text-muted-foreground">
                  {t('appRemoveProjectConfirm', { name: deleteTarget?.name ?? '' })}
                </p>
                {deleteTarget?.id === currentProjectId && (
                  <p className="mt-2 text-xs text-warning">
                    {t('appRemoveProjectRunning')}
                  </p>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="ghost"
                  size="sm"
                  isDisabled={deleting}
                  onPress={() => { confirmState.close(); setDeleteTarget(null) }}
                >
                  {t('appCancel')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  isDisabled={deleting}
                  onPress={() => void handleConfirmRemove()}
                >
                  {deleting ? t('appRemoving') : t('appConfirmRemove')}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  )
}
