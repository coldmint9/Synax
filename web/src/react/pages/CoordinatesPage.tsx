import { GitBranch, Layers, AlertTriangle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { headerGitBranchLabel } from '../../lib/projectGitBranch'
import CoordinatesFlow from '../features/coordinates/CoordinatesFlow'
import { useShellStore } from '../state/shellStore'
import { useCoordinatesState, useCoordinatesStore } from '../state/coordinatesStore'
import type { SourceBinding } from '../../lib/coordinates'

function healthDotColor(health: 'green' | 'yellow' | 'red') {
  if (health === 'green') return 'bg-success'
  if (health === 'yellow') return 'bg-warning'
  return 'bg-destructive'
}

export default function CoordinatesPage() {
  const { projectId = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const project = useShellStore(s => s.projects.find(p => p.id === projectId) ?? null)
  const projectName = project?.name ?? projectId

  const forest = useCoordinatesState(projectId, projectName, s => s.forest)
  const forestSource = useCoordinatesState(projectId, projectName, s => s.forest.source)
  const convergenceReport = useCoordinatesState(projectId, projectName, s => s.convergenceReport)
  const [showFlags, setShowFlags] = useState(false)

  // ── Auto-analyze on import (triggered by query param from ProjectCreatePage) ──
  const autoAnalyzeTriggered = useRef(false)
  const hydrateTriggered = useRef(false)
  const store = useCoordinatesStore(projectId, projectName)

  useEffect(() => {
    if (autoAnalyzeTriggered.current) return
    const shouldAnalyze = searchParams.get('autoAnalyze') === '1'
    if (!shouldAnalyze) return

    autoAnalyzeTriggered.current = true
    hydrateTriggered.current = true // 进行分析路径时跳过 hydrate

    // Gather source info and clear the search params
    const localPath = searchParams.get('localPath')
    const repoUrl = searchParams.get('repoUrl')
    const branch = searchParams.get('branch')

    const next = new URLSearchParams()
    setSearchParams(next, { replace: true })

    // Build the source binding
    let source: SourceBinding
    if (localPath) {
      source = { kind: 'localPath', localPath }
    } else if (repoUrl) {
      source = { kind: 'git', repoUrl, branch: branch || 'main' }
    } else {
      return // scratch — no analysis needed
    }

    // Trigger analysis via coordinatesStore
    const state = store.getState()
    void state.initializeFromRepo(source)
  }, [searchParams, setSearchParams, store])

  // ── 冷启动 hydrate：无 autoAnalyze 参数时，尝试从后端拉取已持久化的 forest。
  // 适用场景：刷新页面 / 换设备 / 清理 LocalStorage 后重新进入 Coordinates 页面。
  useEffect(() => {
    if (hydrateTriggered.current) return
    if (!projectId) return
    if (searchParams.get('autoAnalyze') === '1') return
    hydrateTriggered.current = true
    const state = store.getState()
    void state.hydrateFromBackend()
  }, [projectId, searchParams, store])

  const headerBranch = useMemo(
    () => headerGitBranchLabel(project, forestSource),
    [project, forestSource],
  )

  const topStats = useMemo(() => {
    const nodes = Object.values(forest.nodes)
    const activeStatuses = new Set(['pending', 'draft', 'active', 'review', 'testing'])
    const activeNodes = nodes.filter(n => activeStatuses.has(n.status)).length
    const root = forest.nodes[forest.rootId]
    return {
      rootProgress: Math.round(root?.progress ?? 0),
      activeNodes,
    }
  }, [forest])

  const health = convergenceReport.metrics.overallHealth
  const flagCount = convergenceReport.flags.length

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[hsl(var(--background))]">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/30 px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Layers size={13} className="shrink-0 text-primary" />
          <span className="truncate text-[13px] font-semibold tracking-tight">Coordinates</span>
          <span className="hidden min-w-0 truncate shrink-0 text-[10px] text-muted-foreground/50 sm:inline">
            {projectName}
          </span>
          {headerBranch ? (
            <span
              className="inline-flex min-w-0 shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground/70"
              title={`Git 分支：${headerBranch}`}
            >
              <GitBranch size={10} className="text-muted-foreground/55" />
              <span className="max-w-[10rem] truncate font-mono">{headerBranch}</span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
          <span>align {topStats.rootProgress}%</span>
          <span>active {topStats.activeNodes}</span>
          <span className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${healthDotColor(health)} ${health === 'red' ? 'animate-pulse' : ''}`} />
            <span className={health === 'red' ? 'text-destructive' : health === 'yellow' ? 'text-warning' : 'text-success'}>
              {health}
            </span>
          </span>
          <button
            onClick={() => setShowFlags(!showFlags)}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 transition ${
              flagCount > 0
                ? 'bg-warning/10 text-warning hover:bg-warning/20'
                : 'text-muted-foreground/50 hover:bg-secondary'
            }`}
          >
            <AlertTriangle size={10} />
            {flagCount}
          </button>
        </div>
      </div>

      {/* ── Flags Popover ── */}
      {showFlags && flagCount > 0 && (
        <div className="absolute right-5 top-11 z-40 w-72 rounded-md border border-border/60 bg-card/95 p-3 shadow-lg backdrop-blur-sm">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            收敛信号 ({flagCount})
          </div>
          <div className="max-h-48 space-y-1.5 overflow-y-auto">
            {convergenceReport.flags.map((flag, idx) => (
              <div
                key={idx}
                className={`rounded border px-2 py-1.5 text-[11px] ${
                  flag.level === 'critical'
                    ? 'border-destructive/30 bg-destructive/5 text-destructive'
                    : 'border-warning/30 bg-warning/5 text-warning'
                }`}
              >
                <span className="font-medium">{flag.code}</span>
                <span className="mx-1 opacity-50">·</span>
                <span className="opacity-90">{flag.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <CoordinatesFlow projectId={projectId} projectName={projectName} />
      </div>
    </div>
  )
}
