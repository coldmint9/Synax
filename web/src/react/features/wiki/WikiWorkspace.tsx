import { AlertCircle, BookOpen, Download, Loader2, Map as MapIcon, MessageSquarePlus, RefreshCw, RotateCcw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spinner } from '@heroui/react'
import { useWikiStore } from '../../state/wikiStore'
import { useShellStore } from '../../state/shellStore'
import WikiDocumentTree from './WikiDocumentTree'
import WikiBlockRenderer from './WikiBlockRenderer'
import WikiSourcePanel from './WikiSourcePanel'
import WikiPatchQueue from './WikiPatchQueue'
import WikiDesignMappingPanel from './WikiDesignMappingPanel'
import WikiEvaluationSidebar from './WikiEvaluationSidebar'
import { wikiApi } from '../../../lib/api/wiki'
import { apiFetch } from '../../../lib/api/origin'
import { isProviderNotConfiguredError, LlmProviderRequiredBanner } from '../../components/LlmProviderRequiredBanner'

type RightTab = 'evaluations' | 'source' | 'patches' | 'mapping'

function EmptyState({ projectId, onGenerated }: { projectId: string; onGenerated: () => void }) {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string | null>(null)

  async function handleGenerate() {
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      setError('项目未配置本地路径（source.localPath），无法生成 Wiki。')
      return
    }

    setGenerating(true)
    setError(null)
    setPhase('正在启动生成任务…')

    try {
      await wikiApi.generate(projectId, { workDir, locale: 'zh' })
      setPhase('正在分析代码库，请稍候…')

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
            setError('Wiki 生成失败，请检查项目配置后重试。')
            setGenerating(false)
            setPhase(null)
            return
          }
          if (tree.snapshot?.status === 'outline_ready' || tree.snapshot?.status === 'writing') {
            if (tree.documents.length > 0) {
              onGenerated()
              return
            }
            setPhase('目录结构已生成，正在填充内容…')
          }
          if (tree.snapshot?.status === 'refreshing') {
            setPhase('Agent 正在分析代码库…')
          }
        } catch {
          // transient fetch error — keep polling
        }
      }
      setError('生成超时，请稍后刷新页面查看结果。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败，请重试。')
    } finally {
      setGenerating(false)
      setPhase(null)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="rounded-2xl border border-border/40 bg-card/60 p-8 max-w-sm w-full">
        <BookOpen size={32} className="mx-auto mb-3 text-muted-foreground/30" />
        <h2 className="text-sm font-semibold text-foreground/80">暂无 Wiki</h2>
        <p className="mt-1 text-[12px] text-muted-foreground/60">
          该项目还没有生成 Codebase Design Wiki。
          <br />
          点击下方按钮，AI 将分析代码库并生成结构化设计文档。
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
          {generating ? '生成中…' : '生成 Wiki'}
        </Button>
      </div>
    </div>
  )
}

function FailedState({ projectId, onRetry }: { projectId: string; onRetry: () => void }) {
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string | null>(null)

  async function handleRetry() {
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      setError('项目未配置本地路径（source.localPath），无法重新生成。')
      return
    }

    setRetrying(true)
    setError(null)
    setPhase('重新启动生成任务…')

    try {
      await wikiApi.generate(projectId, { workDir, locale: 'zh' })
      setPhase('正在分析代码库…')

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
            setError('Wiki 生成再次失败，请检查日志。')
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
      setError('生成超时，请稍后刷新页面。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试失败。')
    } finally {
      setRetrying(false)
      setPhase(null)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 max-w-sm w-full">
        <AlertCircle size={32} className="mx-auto mb-3 text-destructive/50" />
        <h2 className="text-sm font-semibold text-foreground/80">Wiki 生成失败</h2>
        <p className="mt-1 text-[12px] text-muted-foreground/60">
          上次生成任务未能完成，可能是代码分析或 LLM 调用出错。
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
          {retrying ? '重新生成中…' : '重新生成'}
        </Button>
      </div>
    </div>
  )
}

export default function WikiWorkspace({ projectId }: { projectId: string }) {
  const snapshot = useWikiStore(s => s.snapshot)
  const selectedDocumentId = useWikiStore(s => s.selectedDocumentId)
  const selectedBlockId = useWikiStore(s => s.selectedBlockId)
  const documents = useWikiStore(s => s.documents)
  const evaluations = useWikiStore(s => s.evaluations)
  const patchesSummary = useWikiStore(s => s.patchesSummary)
  const loading = useWikiStore(s => s.loading)
  const loadLatest = useWikiStore(s => s.loadLatest)
  const loadPatches = useWikiStore(s => s.loadPatches)
  const loadEvaluations = useWikiStore(s => s.loadEvaluations)

  const [rightTab, setRightTab] = useState<RightTab>('evaluations')
  const [refreshing, setRefreshing] = useState(false)
  const [showReinitConfirm, setShowReinitConfirm] = useState(false)
  const [reinitializing, setReinitializing] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(260)

  const selectedDoc = documents.find(d => d.id === selectedDocumentId)

  // Load evaluations when projectId changes
  useEffect(() => {
    if (projectId) void loadEvaluations(projectId)
  }, [projectId, loadEvaluations])

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
      alert('项目未配置 localPath，无法 refresh')
      return
    }
    setRefreshing(true)
    try {
      const res = await apiFetch(`/api/wiki/snapshots/${snapshot.id}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir }),
      })
      const { task } = await res.json() as { task: { id: string } }

      // Poll refresh task until completed/failed (max 60s)
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500))
        const taskRes = await apiFetch(`/api/wiki/refresh-tasks/${task.id}`)
        const taskData = await taskRes.json() as { status: string }
        if (taskData.status === 'completed' || taskData.status === 'failed') break
      }

      await loadLatest(projectId)
      await loadPatches(projectId, 'pending')
      setRightTab('patches')
    } finally {
      setRefreshing(false)
    }
  }

  async function handleReinitialize() {
    const projects = useShellStore.getState().projects
    const project = projects.find(p => p.id === projectId)
    const workDir = project?.source?.localPath
    if (!workDir) {
      alert('项目未配置 localPath，无法重新初始化')
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
      alert('项目未配置 localPath，无法继续生成')
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
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground/60">
          <RefreshCw size={13} className="animate-spin" />
          加载 Wiki…
        </div>
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
      {/* ── Left: Document tree (resizable) ── */}
      <aside style={{ width: sidebarWidth }} className="flex shrink-0 flex-col border-r border-border/30 bg-background/40">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/20 px-3">
          <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
            文档
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing || reinitializing}
              className="rounded p-1 text-muted-foreground/50 hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-40"
              title="更新 Wiki（检测代码变更）"
            >
              <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={handleExport}
              className="rounded p-1 text-muted-foreground/50 hover:bg-secondary hover:text-foreground transition-colors"
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
                  生成未完成 ({documents.filter(d => d.blockIds.length > 0).length}/{documents.length} 篇已完成)
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
                  继续生成
                </button>
                <button
                  type="button"
                  onClick={() => setShowReinitConfirm(true)}
                  disabled={continuing || reinitializing}
                  className="flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-[10px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  {reinitializing ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                  重新生成
                </button>
              </div>
            </div>
          )}
          {snapshot?.status === 'refreshing' && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/5 border-b border-primary/10">
              <Loader2 size={11} className="animate-spin text-primary" />
              <span className="text-[11px] text-primary">
                正在分析代码库…
              </span>
            </div>
          )}
          {snapshot?.status === 'outline_ready' && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/5 border-b border-amber-500/10">
              <Loader2 size={11} className="animate-spin text-amber-600" />
              <span className="text-[11px] text-amber-600">
                目录结构已就绪，正在准备生成内容…
              </span>
            </div>
          )}
          {snapshot?.status === 'writing' && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/5 border-b border-primary/10">
              <Loader2 size={11} className="animate-spin text-primary" />
              <span className="text-[11px] text-primary">
                文档内容生成中… ({documents.filter(d => d.blockIds.length > 0).length}/{documents.length} 篇已完成)
              </span>
            </div>
          )}
          <WikiDocumentTree />
        </div>
        <div className="shrink-0 border-t border-border/30 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setShowReinitConfirm(true)}
            disabled={refreshing || reinitializing || continuing}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-[11px] font-medium text-destructive/70 hover:border-destructive/40 hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
          >
            {reinitializing ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
            {reinitializing ? '重新生成中…' : '重新生成'}
          </button>
        </div>
      </aside>

      {/* ── Resize handle ── */}
      <div
        onMouseDown={handleMouseDown}
        className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
      />

      {/* ── Center: Block content ── */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedDoc ? (
          <>
            <div className="flex h-9 shrink-0 items-center border-b border-border/20 px-5">
              <h1 className="truncate text-[13px] font-semibold text-foreground/90">
                {selectedDoc.title}
              </h1>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <WikiBlockRenderer document={selectedDoc} issuesByBlockId={issuesByBlockId} />
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-[12px] text-muted-foreground/40">从左侧选择文档</p>
          </div>
        )}
      </main>

      {/* ── Right: Evaluations / Source / Patch panel (220px) ── */}
      <aside className="flex w-[220px] shrink-0 flex-col border-l border-border/30 bg-background/40">
        {/* Tab bar */}
        <div className="flex h-9 shrink-0 items-center border-b border-border/20">
          <button
            type="button"
            onClick={() => setRightTab('evaluations')}
            className={`flex-1 h-full text-[11px] font-medium transition-colors ${
              rightTab === 'evaluations'
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground/60 hover:text-foreground'
            }`}
          >
            <MessageSquarePlus size={11} className="mx-auto" />
          </button>
          <button
            type="button"
            onClick={() => setRightTab('source')}
            className={`flex-1 h-full text-[11px] font-medium transition-colors ${
              rightTab === 'source'
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground/60 hover:text-foreground'
            }`}
          >
            Source
          </button>
          <button
            type="button"
            onClick={() => { setRightTab('patches'); void loadPatches(projectId, 'pending') }}
            className={`relative flex-1 h-full text-[11px] font-medium transition-colors ${
              rightTab === 'patches'
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground/60 hover:text-foreground'
            }`}
          >
            Patches
            {patchesSummary.pending > 0 && (
              <span className="absolute right-2 top-1.5 rounded-full bg-warning px-1 py-0.5 text-[8px] font-bold text-warning-foreground leading-none">
                {patchesSummary.pending}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setRightTab('mapping')}
            className={`flex-1 h-full text-[11px] font-medium transition-colors ${
              rightTab === 'mapping'
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground/60 hover:text-foreground'
            }`}
            title="Design Mapping"
          >
            <MapIcon size={11} className="mx-auto" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rightTab === 'evaluations' ? (
            <WikiEvaluationSidebar projectId={projectId} selectedBlockId={selectedBlockId} />
          ) : rightTab === 'source' ? (
            <WikiSourcePanel />
          ) : rightTab === 'patches' ? (
            <WikiPatchQueue projectId={projectId} />
          ) : (
            <WikiDesignMappingPanel projectId={projectId} />
          )}
        </div>
      </aside>

      {showReinitConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-border/40 bg-card p-6 shadow-xl">
            <h3 className="text-sm font-semibold text-foreground/90">确认重新初始化</h3>
            <p className="mt-2 text-[12px] text-muted-foreground leading-relaxed">
              此操作将删除当前项目的所有 Wiki 数据（文档、块、补丁、历史记录等），并重新从代码库生成。此操作不可撤销。
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowReinitConfirm(false)}
                className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleReinitialize}
                className="rounded-lg bg-destructive px-3 py-1.5 text-[12px] font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                确认重新初始化
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}