import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Tabs, Dropdown, Modal, Button, Popover, Checkbox, useOverlayState } from '@heroui/react'
import { BookOpen, Monitor, Search, Settings2, Sun, Moon, Zap, ChevronsUpDown, Plus, Trash2, BookDashed, Ellipsis, Download, RotateCcw, AlertCircle, ListChecks } from 'lucide-react'
import { useShellStore, type ProjectSummary } from '../state/shellStore'
import { useWikiStore, type WikiViewMode } from '../state/wikiStore'
import { useLocale } from '../../hooks/useLocale'
import { wikiApi } from '../../lib/api/wiki'
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
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-bold text-white">
            {draftsReady}
          </span>
        )}
        {draftsGenerating > 0 && draftsReady === 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-primary" />
        )}
      </button>
      <WikiIssueButton />
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
            aria-label="Document tools"
            onAction={(key) => {
              if (key === 'export' && snapshot) {
                window.open(wikiApi.exportSnapshotUrl(snapshot.id), '_blank')
              } else if (key === 'reinit') {
                useWikiStore.getState().setShowReinitConfirm(true)
              }
            }}
          >
            <Dropdown.Item key="export" id="export" textValue="Export all">
              <span className="flex items-center gap-2 text-xs">
                <Download size={12} />
                导出全部
              </span>
            </Dropdown.Item>
            <Dropdown.Item key="reinit" id="reinit" textValue="Reinitialize">
              <span className="flex items-center gap-2 text-xs text-destructive">
                <RotateCcw size={12} />
                重新初始化
              </span>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  )
}

function WikiIssueButton() {
  const evaluations = useWikiStore(s => s.evaluations)
  const documents = useWikiStore(s => s.documents)
  const snapshot = useWikiStore(s => s.snapshot)
  const setViewMode = useWikiStore(s => s.setViewMode)
  const selectDocument = useWikiStore(s => s.selectDocument)
  const planGenStatus = useWikiStore(s => s.planGeneration.status)
  const startPlanGeneration = useWikiStore(s => s.startPlanGeneration)
  const deleteEvaluations = useWikiStore(s => s.deleteEvaluations)
  const projectId = useShellStore(s => s.currentProjectId)

  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [bounce, setBounce] = useState(false)
  const prevCount = useRef(evaluations.length)

  const count = evaluations.length
  const visible = count > 0

  useEffect(() => {
    if (count > prevCount.current) {
      setBounce(true)
      const t = setTimeout(() => setBounce(false), 400)
      prevCount.current = count
      return () => clearTimeout(t)
    }
    prevCount.current = count
  }, [count])

  const grouped = useMemo(() => {
    const groups: Record<string, { docTitle: string; items: typeof evaluations }> = {}
    for (const ev of evaluations) {
      const doc = documents.find(d => d.id === ev.documentId)
      const docId = doc?.id ?? ev.documentId
      if (!groups[docId]) groups[docId] = { docTitle: doc?.title ?? 'Unknown', items: [] }
      groups[docId].items.push(ev)
    }
    return Object.entries(groups)
  }, [evaluations, documents])

  function toggleCheck(id: string) {
    setChecked(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function handleLocate(ev: { documentId: string }) {
    setViewMode('document')
    selectDocument(ev.documentId)
    setTimeout(() => {
      const el = document.getElementById(`wiki-document-${ev.documentId}`)
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 50)
  }

  function handleGenerate() {
    if (!snapshot || !projectId) return
    startPlanGeneration(projectId, snapshot.id)
  }

  async function handleDelete() {
    if (checked.size === 0) return
    await deleteEvaluations([...checked])
    setChecked(new Set())
  }

  if (!visible) return null

  return (
    <div className="wh-issue-btn-wrapper enter">
      <Popover>
        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          aria-label="Issues"
          className={`wh-btn relative ${bounce ? 'wh-bounce' : ''}`}
        >
          <AlertCircle size={13} />
          <span className={`absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[8px] font-bold text-white ${bounce ? 'wh-badge-pop' : ''}`}>
            {count}
          </span>
        </Button>
        <Popover.Content placement="bottom" offset={8}>
          <Popover.Dialog>
            <Popover.Arrow />
            <div className="w-80 max-h-[420px] flex flex-col">
              <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/30">
                <span className="text-xs font-medium text-foreground/80">Issues ({count})</span>
                {checked.size > 0 && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="flex items-center gap-1 text-[10px] text-destructive hover:text-destructive/80 transition-colors"
                  >
                    <Trash2 size={10} />
                    删除 ({checked.size})
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-2 py-2">
                {grouped.map(([docId, { docTitle, items }]) => (
                  <div key={docId} className="mb-3 last:mb-0">
                    <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider px-1.5 mb-1">{docTitle}</p>
                    <div className="flex flex-col gap-0.5">
                      {items.map(ev => (
                        <div
                          key={ev.id}
                          className="flex items-start gap-2 rounded-lg px-1.5 py-1.5 hover:bg-secondary/50"
                        >
                          <Checkbox
                            isSelected={checked.has(ev.id)}
                            onChange={() => toggleCheck(ev.id)}
                            aria-label={ev.content}
                            className="mt-0.5 [&_[data-slot=control]]:h-3.5 [&_[data-slot=control]]:w-3.5"
                          >
                            <Checkbox.Control>
                              <Checkbox.Indicator />
                            </Checkbox.Control>
                          </Checkbox>
                          <button
                            type="button"
                            onClick={() => handleLocate(ev)}
                            className="flex-1 text-left text-[11px] text-foreground/80 line-clamp-2 leading-tight hover:text-primary transition-colors"
                          >
                            {ev.content}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="shrink-0 border-t border-border/20 p-2">
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={planGenStatus === 'generating'}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors disabled:opacity-40"
                >
                  <ListChecks size={10} />
                  {planGenStatus === 'generating' ? '生成中…' : '生成规划'}
                </button>
              </div>
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
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
                {hasProject ? projectName : 'Synax'}
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
