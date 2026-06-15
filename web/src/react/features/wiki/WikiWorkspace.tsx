import { AlertCircle, BookOpen, ListChecks, Loader2, RefreshCw, RotateCcw, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Skeleton } from '@heroui/react'
import WikiProgressBar from './WikiProgressBar'
import { useScrollRestore } from '../../../hooks/useScrollRestore'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiGenerationEvents, type WikiGenPhase } from '../../../hooks/useWikiGenerationEvents'
import { useWikiRefreshListener } from '../../../hooks/useWikiRefreshListener'
import { useWikiStore } from '../../state/wikiStore'
import { useShellStore } from '../../state/shellStore'
import WikiDocumentTree from './WikiDocumentTree'
import WikiDocumentView from './WikiDocumentView'
import WikiDraftPanel from './WikiDraftPanel'
import WikiOutlineProgress from './WikiOutlineProgress'
import WikiOutlineReady from './WikiOutlineReady'
import WikiWritingProgress from './WikiWritingProgress'
import { resolveWikiWritingProgressCounts, resolveGeneratingDocumentId } from './wikiWritingProgressCounts'
import PlanView from './PlanView'
import PlanListView from './PlanListView'
import { wikiApi, WikiGenerationConflictError } from '../../../lib/api/wiki'
import { apiFetch, apiRequest } from '../../../lib/api/origin'
import { handleError, createAppError, AppError } from '../../../lib/errors'
import { isProviderNotConfiguredError, LlmProviderRequiredBanner } from '../../components/LlmProviderRequiredBanner'

function WikiGeneratingShell({
  gen,
  generatingDocumentId,
  sidebarWidth,
  onMouseDown,
}: {
  gen: ReturnType<typeof useWikiGenerationEvents>
  generatingDocumentId: string | null
  sidebarWidth: number
  onMouseDown: (e: React.MouseEvent) => void
}) {
  const { t } = useLocale()

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <aside style={{ width: sidebarWidth }} className="flex shrink-0 flex-col wiki-panel">
        <div className="wiki-panel-header shrink-0 justify-between">
          <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
            {t('wikiDocuments')}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WikiOutlineProgress
            activities={gen.outlineActivities}
            currentActivity={gen.currentActivity}
            phase={gen.phase}
          />
          <WikiDocumentTree generatingDocumentId={generatingDocumentId} />
        </div>
      </aside>
      <div
        onMouseDown={onMouseDown}
        className="wiki-separator shrink-0"
      />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden" />
    </div>
  )
}

function EmptyState({
  onStartGeneration,
}: {
  onStartGeneration: () => Promise<void>
}) {
  const { t } = useLocale()
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    setError(null)
    try {
      await onStartGeneration()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('wikiGenerationError'))
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="rounded-2xl border border-border/40 bg-card/60 p-8 max-w-sm w-full">
        <BookOpen size={32} className="mx-auto mb-3 text-muted-foreground/30" />
        <h2 className="text-sm font-semibold text-foreground/80">{t('wikiEmpty')}</h2>
        <p className="mt-1 text-[12px] text-muted-foreground/60">
          {t('wikiEmptyDesc')}
          <br />
          {t('wikiEmptyDescLine2')}
        </p>

        {error && (
          isProviderNotConfiguredError(error) ? (
            <div className="mt-3">
              <LlmProviderRequiredBanner error={error} onDismiss={() => setError(null)} />
            </div>
          ) : (
            <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-left">
              <AlertCircle size={12} className="shrink-0 text-destructive mt-0.5" />
              <p className="text-[11px] text-destructive leading-snug">{error}</p>
            </div>
          )
        )}

        <Button
          className="mt-4 w-full"
          onPress={handleGenerate}
        >
          <Sparkles size={14} />
          {t('wikiGenerate')}
        </Button>
      </div>
    </div>
  )
}

function FailedState({
  onStartGeneration,
}: {
  onStartGeneration: () => Promise<void>
}) {
  const { t } = useLocale()
  const [error, setError] = useState<string | null>(null)

  async function handleRetry() {
    setError(null)
    try {
      await onStartGeneration()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('wikiRetryError'))
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 max-w-sm w-full">
        <AlertCircle size={32} className="mx-auto mb-3 text-destructive/50" />
        <h2 className="text-sm font-semibold text-foreground/80">{t('wikiFailedTitle')}</h2>
        <p className="mt-1 text-[12px] text-muted-foreground/60">
          {t('wikiFailedDesc')}
        </p>

        {error && (
          isProviderNotConfiguredError(error) ? (
            <div className="mt-3">
              <LlmProviderRequiredBanner error={error} onDismiss={() => setError(null)} />
            </div>
          ) : (
            <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-left">
              <AlertCircle size={12} className="shrink-0 text-destructive mt-0.5" />
              <p className="text-[11px] text-destructive leading-snug">{error}</p>
            </div>
          )
        )}

        <Button
          className="mt-4 w-full"
          onPress={handleRetry}
        >
          <RefreshCw size={14} />
          {t('wikiRetry')}
        </Button>
      </div>
    </div>
  )
}

export default function WikiWorkspace({ projectId }: { projectId: string }) {
  const { t, locale } = useLocale()
  const snapshot = useWikiStore(s => s.snapshot)
  const selectedDocumentId = useWikiStore(s => s.selectedDocumentId)
  const documents = useWikiStore(s => s.documents)
  const loading = useWikiStore(s => s.loading)
  const loadEvaluations = useWikiStore(s => s.loadEvaluations)
  const draftPanelOpen = useWikiStore(s => s.draftPanelOpen)
  const toggleDraftPanel = useWikiStore(s => s.toggleDraftPanel)
  const loadDrafts = useWikiStore(s => s.loadDrafts)
  const draftsSummary = useWikiStore(s => s.draftsSummary)
  const viewMode = useWikiStore(s => s.viewMode)
  const refreshTask = useWikiStore(s => s.refreshTask)
  const setRefreshStarted = useWikiStore(s => s.setRefreshStarted)
  const showReinitConfirm = useWikiStore(s => s.showReinitConfirm)
  const setShowReinitConfirm = useWikiStore(s => s.setShowReinitConfirm)
  const clearForRegeneration = useWikiStore(s => s.clearForRegeneration)

  const loadProjectSnapshot = useWikiStore(s => s.loadProjectSnapshot)
  const patchSnapshotStatus = useWikiStore(s => s.patchSnapshotStatus)

  useWikiRefreshListener(projectId)

  const gen = useWikiGenerationEvents({
    projectId,
    onReconnect: () => {
      void loadProjectSnapshot(projectId)
    },
    onProgress: () => {
      void loadProjectSnapshot(projectId)
    },
  })

  const handleGenerationConflict = useCallback(async (err: WikiGenerationConflictError) => {
    await loadProjectSnapshot(projectId)
    const phase: WikiGenPhase =
      err.generationStatus === 'writing' ? 'writing'
        : err.generationStatus === 'reinitializing' ? 'refreshing'
          : 'refreshing'
    gen.start(err.snapshotId, phase)
  }, [projectId, loadProjectSnapshot, gen])

  const handleStartGeneration = useCallback(async () => {
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      throw new Error(t('wikiNoLocalPath'))
    }
    clearForRegeneration()
    gen.start()
    try {
      await wikiApi.generate(projectId, { workDir, locale })
    } catch (err) {
      if (err instanceof WikiGenerationConflictError) {
        await handleGenerationConflict(err)
        return
      }
      gen.reset()
      throw err
    }
  }, [projectId, locale, t, clearForRegeneration, gen, handleGenerationConflict])

  const refreshing = refreshTask.phase !== 'idle' && refreshTask.phase !== 'completed' && refreshTask.phase !== 'failed'

  const [continuing, setContinuing] = useState(false)
  const [reinitializing, setReinitializing] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [approvingOutline, setApprovingOutline] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(260)

  // Auto-activate generation tracking when a refreshing snapshot is detected
  // (handles page refresh during generation or loading an in-progress snapshot)
  useEffect(() => {
    if (snapshot?.status === 'refreshing' && !gen.active) {
      gen.start(snapshot.id, 'refreshing')
    }
    if (snapshot?.status === 'writing' && !gen.active) {
      gen.start(snapshot.id, 'writing')
    }
    if (
      (snapshot?.status === 'partial' || snapshot?.status === 'failed')
      && gen.active
      && !continuing
      && !reinitializing
    ) {
      gen.reset()
    }
  }, [snapshot?.status, snapshot?.id, gen.active, gen.start, gen.reset, continuing, reinitializing])

  const selectedDoc = documents.find(d => d.id === selectedDocumentId)
  const scrollRef = useScrollRestore(selectedDocumentId)
  const writingProgress = resolveWikiWritingProgressCounts(documents, gen.progress)
  const { done: writtenDocCount, total: writableDocTotal } = writingProgress
  const isActivelyWriting = snapshot?.status === 'writing'
    || (gen.active && gen.phase === 'writing')
  const showIncompleteBanner = (snapshot?.status === 'failed' || snapshot?.status === 'partial')
    && documents.length > 0
    && !isActivelyWriting
  const generatingDocumentId = resolveGeneratingDocumentId(
    documents,
    gen.progress,
    isActivelyWriting,
    snapshot?.status,
  )

  // Load evaluations when projectId changes
  useEffect(() => {
    if (projectId) void loadEvaluations(projectId)
  }, [projectId, loadEvaluations])

  // Load drafts when panel opens
  useEffect(() => {
    if (draftPanelOpen && projectId) void loadDrafts(projectId)
  }, [draftPanelOpen, projectId, loadDrafts])

  // React to refresh task completion via SSE
  useEffect(() => {
    if (refreshTask.phase === 'completed') {
      void loadDrafts(projectId).then(() => {
        const { draftsSummary: summary, draftPanelOpen: alreadyOpen } = useWikiStore.getState()
        if (summary.ready > 0 && !alreadyOpen) toggleDraftPanel()
      })
    }
    if (refreshTask.phase === 'failed' && refreshTask.message) {
      handleError(new Error(refreshTask.message))
    }
  }, [refreshTask.phase, refreshTask.message, projectId, loadDrafts, toggleDraftPanel])

  const isResizing = useRef(false)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    const startX = e.clientX
    const startWidth = sidebarWidth

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return
      const delta = ev.clientX - startX
      const newWidth = Math.max(180, Math.min(480, startWidth + delta))
      setSidebarWidth(newWidth)
    }
    const onMouseUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [sidebarWidth])

  async function handleRefresh() {
    if (!snapshot) return
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      alert(t('wikiNoLocalPath'))
      return
    }
    try {
      const res = await apiFetch(`/api/wiki/snapshots/${snapshot.id}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir, locale }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; code?: string; message?: string }
        const msg = body.error ?? body.message ?? `请求失败 (${res.status})`
        throw createAppError(msg, res.status, body.code)
      }
      const { task } = await res.json() as { task: { id: string } }
      setRefreshStarted(task.id)
    } catch (err) {
      handleError(err)
    }
  }

  async function handleReinitialize() {
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      alert(t('wikiNoLocalPath'))
      return
    }
    setShowReinitConfirm(false)
    clearForRegeneration()
    setReinitializing(true)
    gen.start()
    try {
      await wikiApi.reinitialize(projectId, { workDir, locale })
    } catch (err) {
      if (err instanceof WikiGenerationConflictError) {
        await handleGenerationConflict(err)
        return
      }
      gen.reset()
      handleError(err)
      await loadProjectSnapshot(projectId)
    } finally {
      setReinitializing(false)
    }
  }

  async function handlePause() {
    if (!snapshot) return
    setPausing(true)
    try {
      await wikiApi.pauseGeneration(snapshot.id)
      gen.reset()
      await loadProjectSnapshot(projectId)
    } catch (err) {
      handleError(err)
    } finally {
      setPausing(false)
    }
  }

  async function handleContinue() {
    if (!snapshot) return
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      alert(t('wikiNoLocalPath'))
      return
    }
    setContinuing(true)
    gen.start(snapshot.id, 'writing')
    patchSnapshotStatus('writing')
    try {
      await wikiApi.continueGeneration(snapshot.id, { workDir, locale })
      await loadProjectSnapshot(projectId)
    } catch (err) {
      gen.reset()
      handleError(err)
      await loadProjectSnapshot(projectId)
    } finally {
      setContinuing(false)
    }
  }

  async function handleApproveOutline() {
    if (!snapshot) return
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      alert(t('wikiNoLocalPath'))
      return
    }
    setApprovingOutline(true)
    try {
      await wikiApi.approveSnapshot(snapshot.id, { workDir, locale })
    } catch (err) {
      handleError(err)
    } finally {
      setApprovingOutline(false)
    }
  }

  if (loading.snapshot && !gen.active) {
    return (
      <div className="flex h-full min-h-0 overflow-hidden">
        <aside style={{ width: 260 }} className="flex shrink-0 flex-col wiki-panel">
          <div className="wiki-panel-header shrink-0">
            <Skeleton className="h-3 w-16 rounded-md" />
          </div>
          <div className="flex-1 px-3 py-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full rounded-lg" />
            ))}
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden pt-14 px-5">
          <div className="mx-auto w-full max-w-[86.4ch] space-y-4">
            <Skeleton className="h-6 w-48 rounded-lg" />
            <Skeleton className="h-4 w-full rounded-md" />
            <Skeleton className="h-4 w-3/4 rounded-md" />
            <Skeleton className="h-4 w-5/6 rounded-md" />
            <div className="pt-4 space-y-3">
              <Skeleton className="h-5 w-40 rounded-lg" />
              <Skeleton className="h-4 w-full rounded-md" />
              <Skeleton className="h-4 w-2/3 rounded-md" />
            </div>
          </div>
        </main>
      </div>
    )
  }

  if (gen.active && !snapshot) {
    return (
      <WikiGeneratingShell
        gen={gen}
        generatingDocumentId={resolveGeneratingDocumentId(
          documents,
          gen.progress,
          gen.active && gen.phase === 'writing',
          snapshot?.status,
        )}
        sidebarWidth={sidebarWidth}
        onMouseDown={handleMouseDown}
      />
    )
  }

  if (!snapshot) {
    return <EmptyState onStartGeneration={handleStartGeneration} />
  }

  if (snapshot.status === 'failed' && documents.length === 0 && !gen.active) {
    return <FailedState onStartGeneration={handleStartGeneration} />
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* ── Left: Document tree / Plan list (resizable) ── */}
      <aside style={{ width: sidebarWidth }} className="flex shrink-0 flex-col wiki-panel">
        {viewMode === 'plan' ? (
          <>
            <div className="wiki-panel-header shrink-0 justify-between">
              <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider flex items-center gap-1.5">
                <ListChecks size={11} className="text-primary" />
                {t('wikiPlans')}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <PlanListView projectId={projectId} />
            </div>
          </>
        ) : (
          <>
            <div className="wiki-panel-header shrink-0 justify-between">
              <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
                {t('wikiDocuments')}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={refreshing || gen.active}
                  className="wh-btn !w-6 !h-6 disabled:opacity-40"
                  title="更新 Wiki（检测代码变更）"
                >
                  <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
                </button>
                {refreshing && refreshTask.message && (
                  <span className="text-[10px] text-foreground-500 truncate max-w-[140px]">
                    {refreshTask.message}
                  </span>
                )}
              </div>
            </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {showIncompleteBanner && (
            <div className={`flex flex-col gap-2 px-3 py-2 border-b ${
              snapshot.status === 'partial'
                ? 'bg-amber-500/5 border-amber-500/10'
                : 'bg-destructive/5 border-destructive/20'
            }`}>
              <div className="flex items-center gap-1.5">
                <AlertCircle size={11} className={`shrink-0 ${
                  snapshot.status === 'partial' ? 'text-amber-600' : 'text-destructive'
                }`} />
                <span className={`text-[11px] ${
                  snapshot.status === 'partial' ? 'text-amber-700' : 'text-destructive'
                }`}>
                  {snapshot.status === 'partial'
                    ? t('wikiGenerationPaused', { done: writtenDocCount, total: writableDocTotal })
                    : t('wikiGenerationIncomplete', { done: writtenDocCount, total: writableDocTotal })}
                </span>
              </div>
              {writableDocTotal > 0 && (
                <WikiProgressBar
                  aria-label={t('wikiWritingProgress', { done: writtenDocCount, total: writableDocTotal })}
                  done={writtenDocCount}
                  total={writableDocTotal}
                  value={writingProgress.percent}
                  color={snapshot.status === 'partial' ? 'warning' : 'danger'}
                />
              )}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={continuing || reinitializing || isActivelyWriting}
                  className="wh-pill-btn wh-pill-btn--primary wh-pill-btn--sm"
                >
                  {continuing ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                  {t('wikiContinueGenerate')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowReinitConfirm(true)}
                  disabled={continuing || reinitializing || isActivelyWriting}
                  className="wh-pill-btn wh-pill-btn--danger-soft wh-pill-btn--sm"
                >
                  {reinitializing ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                  {t('wikiRegenerate')}
                </button>
              </div>
            </div>
          )}
          {snapshot?.status === 'refreshing' && (
            <WikiOutlineProgress
              activities={gen.outlineActivities}
              currentActivity={gen.currentActivity}
              phase={gen.phase}
            />
          )}
          {snapshot?.status === 'outline_ready' && (
            <WikiOutlineReady
              approving={approvingOutline}
              disabled={approvingOutline || gen.active}
              onApprove={handleApproveOutline}
            />
          )}
          {isActivelyWriting && (
            <WikiWritingProgress
              documents={documents}
              genProgress={gen.progress}
              pausing={pausing}
              onPause={handlePause}
            />
          )}
          <WikiDocumentTree generatingDocumentId={generatingDocumentId} />
        </div>
          </>
        )}
      </aside>

      {/* ── Resize handle ── */}
      <div
        onMouseDown={handleMouseDown}
        className="wiki-separator shrink-0"
      />

      {/* ── Center: Block content or Plan view ── */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className={`min-h-0 flex-1 flex flex-col overflow-hidden pt-14 ${viewMode !== 'plan' ? 'hidden' : ''}`}>
          <PlanView projectId={projectId} />
        </div>
        <div className={`min-h-0 flex-1 flex flex-col overflow-hidden ${viewMode !== 'document' ? 'hidden' : ''}`}>
          {selectedDoc ? (
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-16 pt-14 sm:px-10">
              <WikiDocumentView document={selectedDoc} projectId={projectId} />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center pt-14">
              <p className="text-[12px] text-muted-foreground/40">{t('wikiSelectDocument')}</p>
            </div>
          )}
        </div>
        {/* Progressive blur fade at top — rendered last so backdrop-filter sees the content */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-14" aria-hidden="true">
          <div className="absolute inset-0 backdrop-blur-[10px]" style={{ maskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)' }} />
          <div className="absolute inset-0 backdrop-blur-[6px]" style={{ maskImage: 'linear-gradient(to bottom, black 25%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 25%, transparent 100%)' }} />
          <div className="absolute inset-0 backdrop-blur-[3px]" style={{ maskImage: 'linear-gradient(to bottom, black 50%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 50%, transparent 100%)' }} />
          <div className="absolute inset-0 backdrop-blur-[1px]" style={{ maskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)' }} />
        </div>
      </main>

      {/* ── Right: Draft Panel (replaces old Patches Drawer) ── */}
      {draftPanelOpen && viewMode === 'document' && (
        <aside className="flex w-[400px] shrink-0 flex-col">
          <WikiDraftPanel />
        </aside>
      )}

      {showReinitConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm bg-background/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-border/40 bg-card p-6 shadow-xl">
            <h3 className="text-sm font-semibold text-foreground/90">{t('wikiReinitConfirmTitle')}</h3>
            <p className="mt-2 text-[12px] text-muted-foreground leading-relaxed">
              {t('wikiReinitConfirmDesc')}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowReinitConfirm(false)}
                className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary transition-colors"
              >
                {t('commonCancel')}
              </button>
              <button
                type="button"
                onClick={handleReinitialize}
                className="rounded-lg bg-destructive px-3 py-1.5 text-[12px] font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                {t('wikiReinitConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
