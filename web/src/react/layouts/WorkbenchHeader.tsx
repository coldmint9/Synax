import { useState, useCallback, useEffect, useRef } from 'react'
import { Tabs, Dropdown, Modal, Button, useOverlayState } from '@heroui/react'
import { BookOpen, Monitor, Search, Settings2, Sun, Moon, Zap, ChevronsUpDown, Plus, Trash2, BookDashed } from 'lucide-react'
import { useShellStore, type ProjectSummary } from '../state/shellStore'
import { useWikiStore, type WikiViewMode } from '../state/wikiStore'
import { useLocale } from '../../hooks/useLocale'
import { NotificationBell } from '../components/notifications/NotificationBell'
import WikiSearchPanel from '../features/wiki/WikiSearchPanel'
import { useWikiSearch, type SearchResult } from '../features/wiki/WikiSearchPanel'
import type { ActivityPanel } from './ActivityBar'

interface WorkbenchHeaderProps {
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
  { id: 'wiki', icon: BookOpen, label: 'Wiki' },
  { id: 'sessions', icon: Monitor, label: 'Sessions' },
]

function WikiToolbar() {
  const { t } = useLocale()
  const viewMode = useWikiStore(s => s.viewMode)
  const setViewMode = useWikiStore(s => s.setViewMode)
  const draftsReady = useWikiStore(s => s.draftsSummary.ready)
  const draftsGenerating = useWikiStore(s => s.draftsSummary.generating)
  const toggleDraftPanel = useWikiStore(s => s.toggleDraftPanel)
  const planGenStatus = useWikiStore(s => s.planGeneration.status)
  const selectDocument = useWikiStore(s => s.selectDocument)
  const selectBlock = useWikiStore(s => s.selectBlock)

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
    setTimeout(() => {
      selectBlock(result.blockId)
      const el = document.getElementById(`wiki-block-${result.blockId}`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 50)
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
      <button type="button" className="wh-btn relative" title="Drafts" onClick={toggleDraftPanel}>
        <BookDashed size={13} />
        {draftsReady > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-bold text-white">
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
    </div>
  )
}

function WikiToolbarPill({ visible }: { visible: boolean }) {
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
  const pillClass = `wh-pill ${phase === 'enter' ? 'wh-pill-enter' : phase === 'exit' ? 'wh-pill-exit' : ''}`

  return (
    <div ref={ref} className={slotClass}>
      <div className={pillClass}>
        <WikiToolbar />
      </div>
    </div>
  )
}

export function WorkbenchHeader({
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
  const showSessionsTab = useShellStore(s => s.preferences.showSessionsTab)

  const visibleTabs = showSessionsTab ? navTabs : navTabs.filter(t => t.id !== 'sessions')

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

  return (
    <div className="workbench-header">
      <div className="wh-pill">
        <Dropdown>
          <Dropdown.Trigger>
            <div role="button" tabIndex={0} className="wh-project-trigger">
              <span className="truncate max-w-[120px] text-xs font-medium">
                {hasProject ? projectName : 'Synapse'}
              </span>
              <ChevronsUpDown size={12} className="text-muted-foreground shrink-0" />
            </div>
          </Dropdown.Trigger>
          <Dropdown.Popover placement="top start">
            <Dropdown.Menu
              aria-label={t('appSwitchProject')}
              onAction={(key) => {
                if (key === '__create__') onCreateProject()
                else onProjectSwitch(key as string)
              }}
            >
              {projects.map(p => (
                <Dropdown.Item key={p.id} id={p.id} textValue={p.name}>
                  <div className="flex items-center justify-between w-full gap-2">
                    <span className="text-xs truncate">{p.name}</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      className="shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition cursor-pointer"
                      onClick={(e) => handleRemoveClick(e, p)}
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

        <div className="wh-divider" />

        <Tabs
          selectedKey={activePanel ?? ''}
          onSelectionChange={(key) => onPanelToggle(key as ActivityPanel)}
          className="wh-tabs"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="主导航" className="wh-tabs-list">
              {visibleTabs.map((tab, i) => {
                const Icon = tab.icon
                return (
                  <Tabs.Tab
                    key={tab.id}
                    id={tab.id}
                    isDisabled={!hasProject}
                    className="wh-tab"
                  >
                    {i > 0 && <Tabs.Separator />}
                    <Icon size={13} />
                    <span>{tab.label}</span>
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
