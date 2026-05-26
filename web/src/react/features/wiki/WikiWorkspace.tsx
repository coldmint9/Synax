import { AlertCircle, BookOpen, Download, ListChecks, Loader2, RefreshCw, RotateCcw, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Drawer, Skeleton, Spinner } from '@heroui/react'
import { useScrollRestore } from '../../../hooks/useScrollRestore'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import { useShellStore } from '../../state/shellStore'
import WikiDocumentTree from './WikiDocumentTree'
import WikiBlockRenderer from './WikiBlockRenderer'
import WikiPatchQueue from './WikiPatchQueue'
import WikiEvaluationSidebar from './WikiEvaluationSidebar'
import PlanView from './PlanView'
import PlanListView from './PlanListView'
import { wikiApi } from '../../../lib/api/wiki'
import { apiFetch, apiRequest } from '../../../lib/api/origin'
import { handleError, createAppError, AppError } from '../../../lib/errors'
import { isProviderNotConfiguredError, LlmProviderRequiredBanner } from '../../components/LlmProviderRequiredBanner'

function EmptyState({ projectId, onGenerated }: { projectId: string; onGenerated: () => void }) {
  const { t } = useLocale()
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string | null>(null)

  async function handleGenerate() {
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      setError(t('wikiNoLocalPath'))
      return
    }

    setGenerating(true)
    setError(null)
    setPhase(t('wikiPhaseStarting'))

    try {
      await wikiApi.generate(projectId, { workDir, locale: 'zh' })
      setPhase(t('wikiPhaseAnalyzing'))

      // Poll /latest until snapshot is ready or failed (max 3 min)
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000))
        try {
          const tree = await wikiApi.getLatest(projectId)
          if (tree.snapshot?.status === 'ready') {
            onGenerated()
            return
          }
          if (tree.snapshot?.status === 'failed') {
            setError(t('wikiGenerationFailed'))
            setGenerating(false)
            setPhase(null)
            return
          }
          if (tree.snapshot?.status === 'outline_ready' || tree.snapshot?.status === 'writing') {
            if (tree.documents.length > 0) {
              onGenerated()
              return
            }
            setPhase(t('wikiPhaseOutlineReady'))
          }
          if (tree.snapshot?.status === 'refreshing') {
            setPhase(t('wikiPhaseAgentAnalyzing'))
          }
        } catch {
          // transient fetch error — keep polling
        }
      }
      setError(t('wikiGenerationTimeout'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('wikiGenerationError'))
    } finally {
      setGenerating(false)
      setPhase(null)
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

        {generating && phase && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-primary/5 px-3 py-2">
            <Spinner size="sm" className="text-primary" />
            <p className="text-[11px] text-primary">{phase}</p>
          </div>
        )}

        <Button
          className="mt-4 w-full"
          onPress={handleGenerate}
          isDisabled={generating}
        >
          {generating
            ? <Spinner size="sm" />
            : <Sparkles size={14} />}
          {generating ? t('wikiGenerating') : t('wikiGenerate')}
        </Button>
      </div>
    </div>
  )
}

function FailedState({ projectId, onRetry }: { projectId: string; onRetry: () => void }) {
  const { t } = useLocale()
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string | null>(null)

  async function handleRetry() {
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      setError(t('wikiNoLocalPathRetry'))
      return
    }

    setRetrying(true)
    setError(null)
    setPhase(t('wikiPhaseRestarting'))

    try {
      await wikiApi.generate(projectId, { workDir, locale: 'zh' })
      setPhase(t('wikiPhaseAnalyzing'))

      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000))
        try {
          const tree = await wikiApi.getLatest(projectId)
          if (tree.snapshot?.status === 'ready') {
            onRetry()
            return
          }
          if (tree.snapshot?.status === 'failed') {
            setError(t('wikiGenerationFailedAgain'))
            setRetrying(false)
            setPhase(null)
            return
          }
          if (tree.snapshot?.status === 'refreshing' && tree.documents.length > 0) {
            onRetry()
            return
          }
          if ((tree.snapshot?.status === 'outline_ready' || tree.snapshot?.status === 'writing') && tree.documents.length > 0) {
            onRetry()
            return
          }
        } catch { /* keep polling */ }
      }
      setError(t('wikiGenerationTimeoutShort'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('wikiRetryError'))
    } finally {
      setRetrying(false)
      setPhase(null)
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

        {retrying && phase && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-primary/5 px-3 py-2">
            <Spinner size="sm" className="text-primary" />
            <p className="text-[11px] text-primary">{phase}</p>
          </div>
        )}

        <Button
          className="mt-4 w-full"
          onPress={handleRetry}
          isDisabled={retrying}
        >
          {retrying ? <Spinner size="sm" /> : <RefreshCw size={14} />}
          {retrying ? t('wikiRetrying') : t('wikiRetry')}
        </Button>
      </div>
    </div>
  )
}

export default function WikiWorkspace({ projectId }: { projectId: string }) {
  const { t } = useLocale()
  const snapshot = useWikiStore(s => s.snapshot)
  const selectedDocumentId = useWikiStore(s => s.selectedDocumentId)
  const selectedBlockId = useWikiStore(s => s.selectedBlockId)
  const documents = useWikiStore(s => s.documents)
  const evaluations = useWikiStore(s => s.evaluations)
  const loading = useWikiStore(s => s.loading)
  const loadLatest = useWikiStore(s => s.loadLatest)
  const loadEvaluations = useWikiStore(s => s.loadEvaluations)
  const patchPanelOpen = useWikiStore(s => s.patchPanelOpen)
  const togglePatchPanel = useWikiStore(s => s.togglePatchPanel)
  const loadPatches = useWikiStore(s => s.loadPatches)
  const viewMode = useWikiStore(s => s.viewMode)

  const [refreshing, setRefreshing] = useState(false)
  const [showReinitConfirm, setShowReinitConfirm] = useState(false)
  const [reinitializing, setReinitializing] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(260)

  const selectedDoc = documents.find(d => d.id === selectedDocumentId)
  const scrollRef = useScrollRestore(selectedDocumentId)

  // Load evaluations when projectId changes
  useEffect(() => {
    if (projectId) void loadEvaluations(projectId)
  }, [projectId, loadEvaluations])

  // Load patches when panel opens
  useEffect(() => {
    if (patchPanelOpen && projectId) void loadPatches(projectId, 'pending')
  }, [patchPanelOpen, projectId, loadPatches])

  // Compute issuesByBlockId
  const issuesByBlockId = useMemo(() => {
    const map = new Map<string, number>()
    for (const ev of evaluations) {
      map.set(ev.blockId, (map.get(ev.blockId) ?? 0) + 1)
    }
    return map
  }, [evaluations])

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

  useEffect(() => {
    const shouldPoll = snapshot?.status === 'refreshing'
      || snapshot?.status === 'outline_ready'
      || snapshot?.status === 'writing'
    if (!shouldPoll) return
    let interval: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (interval) return
      interval = setInterval(() => { loadLatest(projectId) }, 3000)
    }
    const stop = () => {
      if (interval) { clearInterval(interval); interval = null }
    }

    const onVisibility = () => { document.hidden ? stop() : start() }
    document.addEventListener('visibilitychange', onVisibility)
    if (!document.hidden) start()

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [snapshot?.status, projectId, loadLatest])

  function handleExport() {
    if (!snapshot) return
    const url = wikiApi.exportSnapshotUrl(snapshot.id)
    window.open(url, '_blank')
  }

  async function handleRefresh() {
    if (!snapshot) return
    // Get workDir from project record (source.localPath)
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      alert(t('wikiNoLocalPath'))
      return
    }
    setRefreshing(true)
    try {
      const res = await apiFetch(`/api/wiki/snapshots/${snapshot.id}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; code?: string; message?: string }
        const msg = body.error ?? body.message ?? `请求失败 (${res.status})`
        throw createAppError(msg, res.status, body.code)
      }
      const { task } = await res.json() as { task: { id: string } }

      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500))
        const taskRes = await apiFetch(`/api/wiki/refresh-tasks/${task.id}`)
        if (!taskRes.ok) break
        const taskData = await taskRes.json() as { status: string; errorMessage?: string | null }
        if (taskData.status === 'failed') {
          const msg = taskData.errorMessage ?? t('wikiRefreshFailed')
          const code = msg.includes('LLM_PROVIDER_NOT_CONFIGURED') || msg.includes('未配置')
            ? 'LLM_PROVIDER_NOT_CONFIGURED' : undefined
          throw new AppError(msg, { level: 'business', code })
        }
        if (taskData.status === 'completed') break
      }

      await loadLatest(projectId)
      await loadPatches(projectId, 'pending')
    } catch (err) {
      handleError(err)
    } finally {
      setRefreshing(false)
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
    setReinitializing(true)
    try {
      await wikiApi.reinitialize(projectId, { workDir, locale: 'zh' })
      await loadLatest(projectId)
    } finally {
      setReinitializing(false)
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
    try {
      await wikiApi.continueGeneration(snapshot.id, { workDir, locale: 'zh' })
      await loadLatest(projectId)
    } finally {
      setContinuing(false)
    }
  }

  if (loading.snapshot) {
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
        <div className="wiki-separator shrink-0" />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden pt-14 px-5">
          <div className="max-w-2xl space-y-4">
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

  if (!snapshot) {
    return <EmptyState projectId={projectId} onGenerated={() => void loadLatest(projectId)} />
  }

  if (snapshot.status === 'failed' && documents.length === 0) {
    return <FailedState projectId={projectId} onRetry={() => void loadLatest(projectId)} />
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
                  disabled={refreshing || reinitializing}
                  className="wh-btn !w-6 !h-6 disabled:opacity-40"
                  title="更新 Wiki（检测代码变更）"
                >
                  <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
                </button>
                <button
                  type="button"
                  onClick={handleExport}
                  className="wh-btn !w-6 !h-6"
                  title="导出 Markdown"
                >
                  <Download size={11} />
                </button>
              </div>
            </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {snapshot?.status === 'failed' && documents.length > 0 && (
            <div className="flex flex-col gap-2 px-3 py-2 bg-destructive/5 border-b border-destructive/20">
              <div className="flex items-center gap-1.5">
                <AlertCircle size={11} className="shrink-0 text-destructive" />
                <span className="text-[11px] text-destructive">
                  {t('wikiGenerationIncomplete', { done: documents.filter(d => d.blockIds.length > 0).length, total: documents.length })}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={continuing || reinitializing}
                  className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {continuing ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                  {t('wikiContinueGenerate')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowReinitConfirm(true)}
                  disabled={continuing || reinitializing}
                  className="flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-[10px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  {reinitializing ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                  {t('wikiRegenerate')}
                </button>
              </div>
            </div>
          )}
          {snapshot?.status === 'refreshing' && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/5 border-b border-primary/10">
              <Loader2 size={11} className="animate-spin text-primary" />
              <span className="text-[11px] text-primary">
                {t('wikiAnalyzing')}
              </span>
            </div>
          )}
          {snapshot?.status === 'outline_ready' && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/5 border-b border-amber-500/10">
              <Loader2 size={11} className="animate-spin text-amber-600" />
              <span className="text-[11px] text-amber-600">
                {t('wikiOutlineReady')}
              </span>
            </div>
          )}
          {snapshot?.status === 'writing' && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/5 border-b border-primary/10">
              <Loader2 size={11} className="animate-spin text-primary" />
              <span className="text-[11px] text-primary">
                {t('wikiWriting', { done: documents.filter(d => d.blockIds.length > 0).length, total: documents.length })}
              </span>
            </div>
          )}
          <WikiDocumentTree />
        </div>
        <div className="shrink-0 px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-[11px] text-destructive/70 hover:text-destructive"
            onPress={() => setShowReinitConfirm(true)}
            isDisabled={refreshing || reinitializing || continuing}
          >
            {reinitializing ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
            {reinitializing ? t('wikiRegenerating') : t('wikiRegenerate')}
          </Button>
        </div>
          </>
        )}
      </aside>

      {/* ── Resize handle ── */}
      <div
        onMouseDown={handleMouseDown}
        className="wiki-separator shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
      />

      {/* ── Center: Block content or Plan view ── */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className={`min-h-0 flex-1 flex flex-col overflow-hidden pt-14 ${viewMode !== 'plan' ? 'hidden' : ''}`}>
          <PlanView projectId={projectId} />
        </div>
        <div className={`min-h-0 flex-1 flex flex-col overflow-hidden ${viewMode !== 'document' ? 'hidden' : ''}`}>
          {selectedDoc ? (
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-14">
              <WikiBlockRenderer document={selectedDoc} issuesByBlockId={issuesByBlockId} projectId={projectId} />
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

      {/* ── Right: Evaluation sidebar (issues + generate plan) ── */}
      <aside className={`flex w-[220px] shrink-0 flex-col border-l border-border/15 ${viewMode !== 'document' ? 'hidden' : ''}`}>
        <WikiEvaluationSidebar projectId={projectId} selectedBlockId={selectedBlockId} />
      </aside>

      {/* ── Patches Drawer (HeroUI) ── */}
      <Drawer.Backdrop isOpen={patchPanelOpen} onOpenChange={(open) => { if (!open) togglePatchPanel() }} variant="transparent">
        <Drawer.Content placement="right">
          <Drawer.Dialog className="max-w-[320px]">
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading>Patches</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body>
              <WikiPatchQueue projectId={projectId} />
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

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