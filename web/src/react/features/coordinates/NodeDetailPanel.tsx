import { X, Check, XCircle, RotateCcw, AlertTriangle, Zap, Pencil, Play, Shield, ShieldCheck, Clock, ChevronDown, ChevronRight, FileCode2, Hash, Link2, BookOpen, Plus } from 'lucide-react'
import { useState, useMemo, useRef, useEffect } from 'react'
import { Streamdown } from 'streamdown'
import type { CoordNode, AgentRun, CorrectionReason, ConvergenceFlag, SourceLink, CodeIndex, CoordinatesContextIndex, ContextBindingRelation } from '../../../lib/coordinates'
import { latestRun, runCount, rejectionCount, nodeArtifactSummary } from '../../../lib/coordinates'
import type { CoordinatesRunEvent } from '../../../lib/agents/contracts'
import { contextApi, type ContextLink, type ContextEntry } from '../../../lib/api/context'
import { useContextStore } from '../../state/contextStore'
import { useReviewStore } from '../../state/reviewStore'
import { ReviewBadge } from '../review/ReviewBadge'

interface NodeDetailPanelProps {
  node: CoordNode | null
  /** Shown under the header; matches agent dispatch scope (e.g. [Project: rumbling-core] [User: default]). */
  scopeLine: string
  convergenceFlags: ConvergenceFlag[]
  /** v3: forest.links — 用于解析当前节点绑定的 file/symbol evidence */
  links: SourceLink[]
  /** v3: forest.codeIndex — 把 fileId/symbolId 解析为可读 path / qualifiedName */
  codeIndex: CodeIndex
  contextIndex: CoordinatesContextIndex
  /** Goal 节点的子 Action 列表，用于 review 验收 */
  childActions?: { id: string; label: string; status: string }[]
  onBindContextBlock?: (nodeId: string, blockId: string, relation?: ContextBindingRelation) => void
  onAccept: (actionId: string) => void
  onReject: (actionId: string, note: string, reasons: CorrectionReason[]) => void
  onReRun: (actionId: string) => void
  onDispatch: (actionId: string, prompt: string) => void
  onStartGoalReview: (goalId: string) => void
  onUpdateFields: (nodeId: string, fields: { label?: string; summary?: string }) => void
  onClose: () => void
  /** 打开上下文面板并定位到指定会话（Context Links 点击时使用） */
  onOpenContext?: (sessionId: string) => void
}

const CORRECTION_REASONS: { value: CorrectionReason; label: string }[] = [
  { value: 'arch', label: '架构不符' },
  { value: 'logic', label: '逻辑错误' },
  { value: 'perf', label: '性能问题' },
  { value: 'maintain', label: '可维护性' },
]

function statusDot(status: AgentRun['status']): string {
  switch (status) {
    case 'queued': return 'bg-muted-foreground'
    case 'running': return 'bg-primary animate-pulse'
    case 'completed': return 'bg-success'
    case 'failed': return 'bg-destructive'
    case 'cancelled': return 'bg-muted-foreground'
  }
}

function statusColor(status: AgentRun['status']): string {
  switch (status) {
    case 'queued': return 'text-muted-foreground'
    case 'running': return 'text-primary'
    case 'completed': return 'text-success'
    case 'failed': return 'text-destructive'
    case 'cancelled': return 'text-muted-foreground'
  }
}

function verdictBadge(verdict?: AgentRun['verdict']): React.ReactNode {
  if (!verdict) return null
  if (verdict === 'accepted') {
    return <span className="inline-flex items-center gap-1 rounded border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] text-success">accepted</span>
  }
  return <span className="inline-flex items-center gap-1 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">rejected</span>
}

function nodeStatusColor(status: CoordNode['status']): string {
  if (status === 'done') return 'bg-success/10 text-success border-success/30'
  if (status === 'active') return 'bg-primary/10 text-primary border-primary/30'
  if (status === 'rejection' || status === 'cancel') return 'bg-destructive/10 text-destructive border-destructive/30'
  if (status === 'review' || status === 'testing') return 'bg-warning/10 text-warning border-warning/30'
  if (status === 'draft') return 'bg-secondary/70 text-muted-foreground border-border'
  return 'bg-secondary text-muted-foreground border-border'
}

function typeBadgeColor(type: CoordNode['type']): string {
  switch (type) {
    case 'project': return 'bg-primary/15 text-primary'
    case 'feature': return 'bg-run/15 text-run'
    case 'goal': return 'bg-warning/20 text-warning'
    case 'action': return 'bg-agent/15 text-agent'
    default: return 'bg-secondary text-muted-foreground'
  }
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function durationStr(start: number, end?: number): string {
  if (!end) return '—'
  const ms = end - start
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function fileChangeLabel(changeType: string): string {
  if (changeType === 'added') return '新增'
  if (changeType === 'modified') return '修改'
  if (changeType === 'deleted') return '删除'
  if (changeType === 'renamed') return '重命名'
  return '变更'
}

function fileChangeClass(changeType: string): string {
  if (changeType === 'added') return 'bg-success/10 text-success border-success/25'
  if (changeType === 'deleted') return 'bg-destructive/10 text-destructive border-destructive/25'
  if (changeType === 'modified') return 'bg-primary/10 text-primary border-primary/25'
  return 'bg-secondary/70 text-muted-foreground border-border/50'
}

export default function NodeDetailPanel({
  node,
  scopeLine,
  convergenceFlags,
  links,
  codeIndex,
  contextIndex,
  childActions,
  onBindContextBlock,
  onAccept,
  onReject,
  onReRun,
  onDispatch,
  onStartGoalReview,
  onUpdateFields,
  onClose,
  onOpenContext,
}: NodeDetailPanelProps) {
  const [correctionNote, setCorrectionNote] = useState('')
  const [correctionReasons, setCorrectionReasons] = useState<CorrectionReason[]>([])
  const [showRejectForm, setShowRejectForm] = useState(false)

  // 展开查看某次 run 详情（input / output）的 runId 集合
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set())
  const toggleRunExpanded = (runId: string) => {
    setExpandedRunIds(prev => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

  // 内联编辑态
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const [summaryDraft, setSummaryDraft] = useState('')
  const [promptDraft, setPromptDraft] = useState('')

  // 切换节点时同步本地草稿
  useEffect(() => {
    setEditingLabel(false)
    setLabelDraft(node?.label ?? '')
    setSummaryDraft(node?.summary ?? '')
    setPromptDraft(node?.summary ?? '')
  }, [node?.id])

  const currentRun = useMemo(() => node ? latestRun(node) : undefined, [node])
  const artifact = useMemo(() => node ? nodeArtifactSummary(node) : undefined, [node])
  const runs = useMemo(() => node?.runs ?? [], [node])
  const rCount = useMemo(() => node ? runCount(node) : 0, [node])
  const rejCount = useMemo(() => node ? rejectionCount(node) : 0, [node])
  const nodeFlags = useMemo(
    () => convergenceFlags.filter(f => f.nodeId === node?.id),
    [convergenceFlags, node],
  )
  // v3 evidence: 将当前节点的 SourceLink 解析为可读的 file / symbol 条目
  const evidences = useMemo(() => {
    if (!node) return { files: [], symbols: [] }
    const fileMap = new Map(codeIndex.files.map(f => [f.id, f]))
    const symMap = new Map(codeIndex.symbols.map(s => [s.id, s]))
    const fileItems: { id: string; path: string; language: string; confidence: number; createdBy: SourceLink['createdBy'] }[] = []
    const symItems: { id: string; name: string; qualifiedName: string; path: string; startLine: number; endLine: number; confidence: number; createdBy: SourceLink['createdBy'] }[] = []
    for (const link of links) {
      if (link.nodeId !== node.id) continue
      if (link.anchor.kind === 'file') {
        const f = fileMap.get(link.anchor.fileId)
        if (f) fileItems.push({ id: f.id, path: f.path, language: f.language, confidence: link.confidence, createdBy: link.createdBy })
      } else if (link.anchor.kind === 'symbol') {
        const s = symMap.get(link.anchor.symbolId)
        if (s) {
          const f = fileMap.get(s.fileId)
          symItems.push({
            id: s.id,
            name: s.name,
            qualifiedName: s.qualifiedName,
            path: f?.path ?? s.fileId,
            startLine: s.range.startLine,
            endLine: s.range.endLine,
            confidence: link.confidence,
            createdBy: link.createdBy,
          })
        }
      }
    }
    return { files: fileItems, symbols: symItems }
  }, [node, links, codeIndex])

  const isAction = node?.type === 'action'
  const canAccept = isAction && currentRun?.status === 'completed' && !currentRun?.verdict
  const canReject = isAction && currentRun?.status === 'completed' && !currentRun?.verdict
  const canReRun = isAction && (node.status === 'rejection' || currentRun?.status === 'failed')

  // ── Context Links: 展示该节点被哪些 context entries 引用 ──
  const ctxProjectId = useContextStore((s) => s.projectId)
  const ctxSelectSession = useContextStore((s) => s.selectSession)
  const [contextLinks, setContextLinks] = useState<ContextLink[]>([])
  const [contextEntries, setContextEntries] = useState<Record<string, ContextEntry>>({})
  const [contextExpanded, setContextExpanded] = useState(false)
  const [contextSuggestions, setContextSuggestions] = useState<Array<{
    block: { id: string; kind: string; title: string; content: string }
    relation: ContextBindingRelation
    score: number
    reason: string
  }>>([])

  const nodeContextBindings = useMemo(
    () => node
      ? contextIndex.bindings.filter(b => b.targetKind === 'node' && b.targetId === node.id)
      : [],
    [contextIndex.bindings, node],
  )
  const contextBlocksById = useMemo(
    () => new Map(contextIndex.blocks.map(b => [b.id, b])),
    [contextIndex.blocks],
  )
  const nodeContextBlocks = useMemo(
    () => nodeContextBindings
      .map(binding => ({ binding, block: contextBlocksById.get(binding.blockId) }))
      .filter((item): item is { binding: typeof nodeContextBindings[number]; block: NonNullable<ReturnType<typeof contextBlocksById.get>> } => Boolean(item.block)),
    [nodeContextBindings, contextBlocksById],
  )

  useEffect(() => {
    if (!node?.id || !ctxProjectId) {
      setContextSuggestions([])
      return
    }
    let cancelled = false
    contextApi
      .suggestContext({ projectId: ctxProjectId, nodeId: node.id, runId: currentRun?.runId, limit: 5 })
      .then((resp) => {
        if (!cancelled) setContextSuggestions(resp.items)
      })
      .catch(() => {
        if (!cancelled) setContextSuggestions([])
      })
    return () => {
      cancelled = true
    }
  }, [node?.id, ctxProjectId, currentRun?.runId])

  // ── Review integration helpers (goal → action 验收) ──
  const isGoal = node?.type === 'goal'
  const childActionIds = isGoal ? (childActions?.map(a => a.id) ?? []) : []
  const latestPackageByGoal = useReviewStore(s => s.latestPackageByGoal)
  const packagesById = useReviewStore(s => s.packagesById)
  const runningReview = useReviewStore(s => s.running && s.activeGoalId === node?.id)
  const latestGoalPackage = isGoal && node ? packagesById[latestPackageByGoal[node.id]] : undefined

  useEffect(() => {
    if (!node?.id || !ctxProjectId) {
      setContextLinks([])
      setContextEntries({})
      return
    }
    let cancelled = false
    contextApi
      .linksByNode(ctxProjectId, node.id)
      .then(async (resp) => {
        if (cancelled) return
        setContextLinks(resp.items)
        // 批量拉关联的 entry（并行 + 容错）
        const pairs = await Promise.all(
          resp.items.map((l) =>
            contextApi.getEntry(l.entryId).then(
              (e) => [l.entryId, e] as const,
              () => null,
            ),
          ),
        )
        if (cancelled) return
        const map: Record<string, ContextEntry> = {}
        for (const p of pairs) if (p) map[p[0]] = p[1]
        setContextEntries(map)
      })
      .catch(() => {
        if (!cancelled) setContextLinks([])
      })
    return () => {
      cancelled = true
    }
  }, [node?.id, ctxProjectId])

  const toggleReason = (reason: CorrectionReason) => {
    setCorrectionReasons(prev =>
      prev.includes(reason) ? prev.filter(r => r !== reason) : [...prev, reason]
    )
  }

  const handleReject = () => {
    if (!node || correctionReasons.length === 0) return
    onReject(node.id, correctionNote, correctionReasons)
    setCorrectionNote('')
    setCorrectionReasons([])
    setShowRejectForm(false)
  }

  if (!node) return null

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col border-l border-border/40 bg-card/95 backdrop-blur-sm">
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-border/30 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${typeBadgeColor(node.type)}`}>
            {node.type}
          </span>
          {editingLabel ? (
            <input
              autoFocus
              value={labelDraft}
              onChange={e => setLabelDraft(e.target.value)}
              onBlur={() => {
                const next = labelDraft.trim()
                if (next && next !== node.label) onUpdateFields(node.id, { label: next })
                setEditingLabel(false)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.currentTarget.blur() }
                else if (e.key === 'Escape') { setLabelDraft(node.label); setEditingLabel(false) }
              }}
              className="min-w-0 flex-1 rounded border border-border/60 bg-background/60 px-1.5 py-0.5 text-sm font-semibold outline-none focus:border-primary/60"
            />
          ) : (
            <button
              type="button"
              onClick={() => { setLabelDraft(node.label); setEditingLabel(true) }}
              title="Edit label"
              className="group flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-semibold hover:text-primary"
            >
              <span className="truncate">{node.label}</span>
              <Pencil size={10} className="shrink-0 opacity-0 transition group-hover:opacity-60" />
            </button>
          )}
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>

      <div className="border-b border-border/30 px-4 py-2">
        <p className="truncate text-[10px] font-mono text-muted-foreground" title={scopeLine}>
          {scopeLine}
        </p>
      </div>

      {/* ── Status Bar ── */}
      <div className="border-b border-border/30 px-4 py-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] uppercase ${nodeStatusColor(node.status)}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${node.status === 'active' ? 'bg-primary animate-pulse' : node.status === 'done' ? 'bg-success' : node.status === 'rejection' ? 'bg-destructive' : 'bg-muted-foreground'}`} />
            {node.status}
          </span>
        </div>
        {node.executor && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={`inline-block h-2 w-2 rounded-full ${node.executor.type === 'agent' ? 'bg-agent' : 'bg-human'}`} />
            <span className={node.executor.type === 'agent' ? 'text-agent' : 'text-human'}>
              {node.executor.type}
            </span>
            <span>·</span>
            <span>{node.executor.name}</span>
          </div>
        )}
      </div>

      {/* ── Scrollable Content ── */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

        {/* ── Summary (editable) ── */}
        <div>
          <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Summary</h4>
          <textarea
            value={summaryDraft}
            onChange={e => setSummaryDraft(e.target.value)}
            onBlur={() => {
              if (summaryDraft !== node.summary) onUpdateFields(node.id, { summary: summaryDraft })
            }}
            placeholder="Describe this node..."
            rows={3}
            className="w-full resize-none rounded-md border border-border/40 bg-background/60 px-2.5 py-1.5 text-xs leading-relaxed text-foreground/90 outline-none placeholder:text-muted-foreground/50 focus:border-primary/50"
          />
          {isAction && node.review && (
            <div className="mt-2 rounded border border-border/40 bg-background/60 px-2 py-1 text-xs text-muted-foreground">
              <ReviewBadge review={node.review} />
              {node.review.summary && <div className="mt-1 line-clamp-2">{node.review.summary}</div>}
            </div>
          )}
        </div>

        {/* ── Node Context Inspector ── */}
        {(nodeContextBlocks.length > 0 || contextSuggestions.length > 0 || currentRun?.contextSnapshotId) && (
          <div>
            <h4 className="mb-2 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <BookOpen size={10} />
              Context
            </h4>
            {currentRun?.contextSnapshotId && (
              <div className="mb-2 rounded border border-primary/20 bg-primary/5 px-2 py-1 text-[10px] text-primary/80">
                Run snapshot: <span className="font-mono">{currentRun.contextSnapshotId}</span>
              </div>
            )}
            {nodeContextBlocks.length > 0 && (
              <div className="space-y-1.5">
                {nodeContextBlocks.slice(0, 6).map(({ binding, block }) => (
                  <div
                    key={binding.id}
                    className="rounded-md border border-border/40 bg-card/60 px-2 py-1.5 text-[11px]"
                    title={block.content}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-primary/10 px-1 py-px font-mono text-[9px] uppercase text-primary/80">
                        {binding.relation}
                      </span>
                      <span className="rounded bg-secondary/60 px-1 py-px font-mono text-[9px] uppercase text-muted-foreground">
                        {block.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{block.title}</span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                      {block.content}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {contextSuggestions.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Suggestions
                </div>
                {contextSuggestions.slice(0, 4).map((s) => (
                  <button
                    key={s.block.id}
                    type="button"
                    onClick={() => onBindContextBlock?.(node.id, s.block.id, s.relation)}
                    className="flex w-full items-start gap-1.5 rounded-md border border-border/40 bg-background/60 px-2 py-1.5 text-left text-[11px] transition hover:border-primary/40 hover:bg-primary/5"
                    title={s.reason}
                  >
                    <Plus size={10} className="mt-0.5 shrink-0 text-primary/70" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{s.block.title}</span>
                      <span className="block line-clamp-1 text-[10px] text-muted-foreground">{s.reason}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                      {s.score.toFixed(2)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Dispatch Prompt (action-only, always available) ── */}
        {isAction && (() => {
          const busy = currentRun?.status === 'running' || currentRun?.status === 'queued'
          const canRun = !busy && promptDraft.trim().length > 0
          return (
            <div>
              <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Dispatch Prompt</h4>
              <textarea
                value={promptDraft}
                onChange={e => setPromptDraft(e.target.value)}
                placeholder="输入指令并对该 action 执行新一轮 agent run（Ctrl/Cmd + Enter 发送）"
                rows={3}
                disabled={busy}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canRun) {
                    e.preventDefault()
                    onDispatch(node.id, promptDraft.trim())
                  }
                }}
                className="w-full resize-none rounded-md border border-primary/30 bg-background/60 px-2.5 py-1.5 text-xs leading-relaxed text-foreground/90 outline-none placeholder:text-muted-foreground/50 focus:border-primary/60 disabled:opacity-60"
              />
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">
                  {busy ? 'Agent 执行中…' : '下发后会追加新的 run 并同步更新 summary'}
                </span>
                <button
                  type="button"
                  disabled={!canRun}
                  onClick={() => onDispatch(node.id, promptDraft.trim())}
                  className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Play size={11} /> Run
                </button>
              </div>
            </div>
          )
        })()}

        {/* ── Artifact (latest run) ── */}
        {artifact && (
          <div>
            <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Artifact</h4>
            <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground/90">
              {artifact}
            </div>
          </div>
        )}

        {/* ── Evidence (v3): 当前节点绑定的 file / symbol 具体清单 ── */}
        {(evidences.files.length > 0 || evidences.symbols.length > 0) && (
          <div>
            <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Evidence ({evidences.files.length} files · {evidences.symbols.length} symbols)
            </h4>
            <div className="space-y-2">
              {evidences.files.length > 0 && (
                <div className="space-y-1">
                  {evidences.files.map(f => (
                    <div
                      key={f.id}
                      className="flex items-center gap-1.5 rounded-md border border-border/40 bg-card/60 px-2 py-1 text-[11px] font-mono text-foreground/90"
                      title={f.path}
                    >
                      <FileCode2 size={11} className="shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1">{f.path}</span>
                      {f.language && (
                        <span className="shrink-0 rounded bg-secondary/60 px-1 py-px text-[9px] uppercase text-muted-foreground">
                          {f.language}
                        </span>
                      )}
                      <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/70" title={`createdBy ${f.createdBy}`}>
                        {(f.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {evidences.symbols.length > 0 && (
                <div className="space-y-1">
                  {evidences.symbols.map(s => (
                    <div
                      key={s.id}
                      className="rounded-md border border-border/40 bg-card/60 px-2 py-1 text-[11px]"
                      title={s.qualifiedName}
                    >
                      <div className="flex items-center gap-1.5 font-mono text-foreground/90">
                        <Hash size={11} className="shrink-0 text-muted-foreground" />
                        <span className="truncate flex-1">{s.qualifiedName || s.name}</span>
                        <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/70" title={`createdBy ${s.createdBy}`}>
                          {(s.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-0.5 truncate pl-[18px] font-mono text-[10px] text-muted-foreground">
                        {s.path}:{s.startLine}–{s.endLine}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Context Links (v5): 此节点关联的 context entries ── */}
        {contextLinks.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setContextExpanded((v) => !v)}
              className="flex w-full items-center gap-1 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              {contextExpanded ? (
                <ChevronDown size={10} className="shrink-0" />
              ) : (
                <ChevronRight size={10} className="shrink-0" />
              )}
              <Link2 size={10} className="shrink-0" />
              Context Links ({contextLinks.length})
            </button>
            {contextExpanded && (
              <div className="mt-2 space-y-1.5">
                {contextLinks.map((l) => {
                  const entry = contextEntries[l.entryId]
                  const roleColor =
                    entry?.role === 'user'
                      ? 'bg-blue-500/15 text-blue-400'
                      : entry?.role === 'assistant'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : entry?.role === 'tool'
                          ? 'bg-orange-500/15 text-orange-400'
                          : 'bg-secondary text-muted-foreground'
                  return (
                    <button
                      key={l.id}
                      type="button"
                      disabled={!entry}
                      onClick={() => {
                        if (!entry) return
                        void ctxSelectSession(entry.sessionId)
                        onOpenContext?.(entry.sessionId)
                      }}
                      className="w-full rounded-md border border-border/40 bg-card/60 px-2 py-1.5 text-left transition hover:border-primary/40 hover:bg-primary/5 disabled:cursor-default disabled:opacity-60"
                      title={entry ? `${l.linkType} · session ${entry.sessionId}` : l.linkType}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-secondary/60 px-1 py-px font-mono text-[9px] uppercase text-muted-foreground">
                          {l.linkType}
                        </span>
                        {entry && (
                          <span className={`rounded px-1 py-px font-mono text-[9px] uppercase ${roleColor}`}>
                            {entry.role}
                          </span>
                        )}
                        <span className="ml-auto font-mono text-[9px] tabular-nums text-muted-foreground/70">
                          {(l.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-foreground/80">
                        {entry ? entry.content : <span className="italic text-muted-foreground">entry unavailable ({l.entryId})</span>}
                      </div>
                      {entry && (
                        <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                          #{entry.sequence} · {formatTime(new Date(entry.createdAt).getTime())}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Agent Output — shown whenever there are any agent events, regardless of run status ── */}
        {isAction && currentRun && currentRun.events.length > 0 && (
          <LiveFeed events={currentRun.events} isRunning={currentRun.status === 'running'} />
        )}

        {/* ── Run Timeline (action only, expandable) ── */}
        {isAction && runs.length > 0 && (
          <div>
            <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Run Timeline ({rCount} runs · {rejCount} rejected)
            </h4>
            <div className="space-y-2">
              {[...runs].reverse().map((run, idx) => {
                const isLatest = idx === 0
                const expanded = expandedRunIds.has(run.runId)
                const changeSummary = run.changeSummary
                const fileChanges = run.fileChanges ?? []
                const changeTypes = Array.from(new Set(fileChanges.map(c => c.changeType))).slice(0, 3)
                return (
                  <div
                    key={run.runId}
                    className={`rounded-md border ${
                      isLatest ? 'border-border bg-card' : 'border-border/40 bg-card/50'
                    }`}
                  >
                    {/* Header: clickable to toggle expansion */}
                    <button
                      type="button"
                      onClick={() => toggleRunExpanded(run.runId)}
                      className="w-full px-3 py-2 text-left transition hover:bg-secondary/40 rounded-md"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {expanded
                            ? <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
                            : <ChevronRight size={11} className="shrink-0 text-muted-foreground" />}
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDot(run.status)}`} />
                          <span className="text-[11px] font-medium">
                            Run #{runs.length - idx}
                            {isLatest && <span className="ml-1 text-[9px] text-primary">(latest)</span>}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {verdictBadge(run.verdict)}
                          <span className={`text-[10px] ${statusColor(run.status)}`}>{run.status}</span>
                        </div>
                      </div>

                      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground pl-[18px]">
                        <span>{formatTime(run.startedAt)}</span>
                        <span>·</span>
                        <span>{durationStr(run.startedAt, run.completedAt)}</span>
                        <span>·</span>
                        <span>{run.provider}</span>
                        {run.events.length > 0 && (
                          <>
                            <span>·</span>
                            <span>{run.events.length} events</span>
                          </>
                        )}
                      </div>

                      {!expanded && run.artifactSummary && (
                        <div className="mt-1.5 text-[11px] text-foreground/80 line-clamp-2 pl-[18px]">
                          {run.artifactSummary}
                        </div>
                      )}
                      {!expanded && changeSummary && changeSummary.files > 0 && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[18px] text-[10px] text-muted-foreground">
                          <span>{changeSummary.files} files</span>
                          <span className="text-success">+{changeSummary.insertions}</span>
                          <span className="text-destructive">-{changeSummary.deletions}</span>
                          {changeTypes.map(type => (
                            <span key={type} className={`rounded border px-1 py-px ${fileChangeClass(type)}`}>
                              {fileChangeLabel(type)}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>

                    {/* Expanded body: user input + agent output */}
                    {expanded && (
                      <div className="border-t border-border/30 px-3 py-2 space-y-2.5">
                        <div>
                          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            User Input
                          </div>
                          {run.prompt ? (
                            <div className="rounded border border-human/30 bg-human/5 px-2 py-1.5">
                              <Streamdown
                                className="feed-prose min-w-0 break-words"
                                parseIncompleteMarkdown
                                mode="static"
                                controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
                                lineNumbers={false}
                              >
                                {run.prompt}
                              </Streamdown>
                            </div>
                          ) : (
                            <div className="rounded border border-border/30 bg-background/40 px-2 py-1.5 text-[11px] italic text-muted-foreground">
                              — (早期 run 未记录 prompt)
                            </div>
                          )}
                        </div>

                        <div>
                          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            Agent Output
                          </div>
                          {run.events.length > 0 ? (
                            <RunEventList
                              events={run.events}
                              isStreaming={run.status === 'running'}
                            />
                          ) : (
                            <div className="rounded border border-border/30 bg-background/40 px-2 py-1.5 text-[11px] italic text-muted-foreground">
                              {run.status === 'running' || run.status === 'queued'
                                ? 'Waiting for output…'
                                : 'No output captured.'}
                            </div>
                          )}
                        </div>

                        {run.artifactSummary && (
                          <div>
                            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                              Artifact
                            </div>
                            <div className="rounded border border-primary/20 bg-primary/5 px-2 py-1.5 text-[11px] text-foreground/90">
                              {run.artifactSummary}
                            </div>
                          </div>
                        )}

                        {fileChanges.length > 0 && (
                          <div>
                            <div className="mb-1 flex items-center justify-between gap-2">
                              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                File Changes
                              </div>
                              {changeSummary && (
                                <div className="text-[10px] text-muted-foreground">
                                  {changeSummary.files} files · <span className="text-success">+{changeSummary.insertions}</span> <span className="text-destructive">-{changeSummary.deletions}</span>
                                </div>
                              )}
                            </div>
                            <div className="max-h-56 overflow-y-auto rounded border border-border/30 bg-background/40">
                              {fileChanges.slice(0, 20).map((change, changeIdx) => (
                                <div key={`${change.path}-${changeIdx}`} className="flex items-center gap-2 border-b border-border/20 px-2 py-1.5 last:border-b-0">
                                  <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium ${fileChangeClass(change.changeType)}`}>
                                    {fileChangeLabel(change.changeType)}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85" title={change.path}>
                                    {change.path}
                                  </span>
                                  {change.additions !== undefined || change.deletions !== undefined ? (
                                    <span className="shrink-0 font-mono text-[10px]">
                                      <span className="text-success">+{change.additions ?? 0}</span>{' '}
                                      <span className="text-destructive">-{change.deletions ?? 0}</span>
                                    </span>
                                  ) : (
                                    <span className="shrink-0 text-[10px] text-muted-foreground">changed</span>
                                  )}
                                </div>
                              ))}
                              {fileChanges.length > 20 && (
                                <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
                                  +{fileChanges.length - 20} more
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Correction (always visible on rejected runs, at bottom) */}
                    {run.verdict === 'rejected' && run.correctionNote && (
                      <div className="mx-3 mb-2 mt-0 rounded border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive/90">
                        <span className="font-medium">纠正: </span>{run.correctionNote}
                        {run.correctionReasons && run.correctionReasons.length > 0 && (
                          <div className="mt-1 flex gap-1">
                            {run.correctionReasons.map(r => (
                              <span key={r} className="rounded bg-destructive/10 px-1 py-0.5 text-[9px]">
                                {CORRECTION_REASONS.find(c => c.value === r)?.label ?? r}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Decision Buttons (action only, when latest run is verdict-pending) ── */}
        {isAction && (canAccept || canReject || canReRun) && !showRejectForm && (
          <div>
            <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Decision</h4>
            <div className="flex gap-2">
              {canAccept && (
                <button
                  onClick={() => onAccept(node.id)}
                  className="flex items-center gap-1.5 rounded-md border border-success/40 bg-success/10 px-3 py-1.5 text-xs font-medium text-success transition hover:bg-success/20"
                >
                  <Check size={12} /> Accept
                </button>
              )}
              {canReject && (
                <button
                  onClick={() => setShowRejectForm(true)}
                  className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20"
                >
                  <XCircle size={12} /> Reject
                </button>
              )}
              {canReRun && (
                <button
                  onClick={() => onReRun(node.id)}
                  className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/20"
                >
                  <RotateCcw size={12} /> Re-run
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Goal Review: 子 Action 验收 ── */}
        {isGoal && childActions && childActions.length > 0 && (
          <div className="rounded-md border border-border/40 bg-background/40">
            <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
              <div className="flex items-center gap-2">
                <Shield size={12} className="text-primary" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">验收闭环</span>
              </div>
              {node.review ? <ReviewBadge review={node.review} /> : <span className="text-[10px] text-muted-foreground">{childActions.length} 个 Action</span>}
            </div>
            <div className="px-3 py-2 space-y-2">
              <div className="max-h-48 overflow-y-auto space-y-1">
                {childActions.map(action => {
                  const isDone = action.status === 'done'
                  return (
                    <div key={action.id} className="flex items-center gap-2 rounded-md border border-border/30 bg-background/60 px-2 py-1.5 text-[11px]">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isDone ? 'bg-success' : 'bg-muted-foreground'}`} />
                      <span className="flex-1 truncate">{action.label}</span>
                      <span className="shrink-0 rounded bg-secondary/60 px-1 py-0.5 text-[9px] text-muted-foreground">{action.status}</span>
                    </div>
                  )
                })}
              </div>
              <button
                onClick={() => onStartGoalReview(node.id)}
                disabled={childActionIds.length === 0 || runningReview}
                className="w-full px-3 py-1.5 bg-primary/10 text-primary text-xs rounded-md border border-primary/30 hover:bg-primary/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <Shield size={14} />
                {runningReview ? '验收中…' : `开始验收 (${childActionIds.length})`}
              </button>
              {latestGoalPackage && (
                <div className="rounded border border-border/30 bg-background/60 px-2 py-1.5 space-y-1">
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <ShieldCheck size={10} className={latestGoalPackage.run.overallVerdict === 'accepted' ? 'text-success' : 'text-destructive'} />
                    <span className="font-medium">{latestGoalPackage.run.overallVerdict}</span>
                    <span className="ml-auto text-muted-foreground/60">{latestGoalPackage.decisions.length} decisions</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground line-clamp-3">{latestGoalPackage.run.summary}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Reject Form ── */}
        {showRejectForm && (
          <div className="space-y-3 rounded-md border border-destructive/20 bg-destructive/5 p-3">
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-destructive">Correction Details</h4>
            <div className="space-y-2">
              <div className="text-[11px] text-muted-foreground">纠正原因</div>
              <div className="flex flex-wrap gap-1.5">
                {CORRECTION_REASONS.map(r => (
                  <button
                    key={r.value}
                    onClick={() => toggleReason(r.value)}
                    className={`rounded-md border px-2 py-1 text-[11px] transition ${
                      correctionReasons.includes(r.value)
                        ? 'border-destructive/50 bg-destructive/15 text-destructive'
                        : 'border-border/50 bg-background/60 text-muted-foreground hover:bg-secondary'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-1">纠正注记</div>
              <textarea
                value={correctionNote}
                onChange={e => setCorrectionNote(e.target.value)}
                placeholder="描述为什么拒绝，以及期望的改进方向..."
                className="w-full rounded-md border border-border/50 bg-background/60 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none"
                rows={3}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleReject}
                disabled={correctionReasons.length === 0}
                className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/15 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/25 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <XCircle size={12} /> Confirm Reject
              </button>
              <button
                onClick={() => { setShowRejectForm(false); setCorrectionNote(''); setCorrectionReasons([]) }}
                className="rounded-md border border-border/50 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Convergence Flags ── */}
        {nodeFlags.length > 0 && (
          <div>
            <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              ⚠ 收敛信号 ({nodeFlags.length})
            </h4>
            <div className="space-y-1.5">
              {nodeFlags.map((flag, idx) => (
                <div
                  key={idx}
                  className={`rounded-md border px-2.5 py-1.5 text-[11px] ${
                    flag.level === 'critical'
                      ? 'border-destructive/30 bg-destructive/5 text-destructive'
                      : 'border-warning/30 bg-warning/5 text-warning'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle size={10} />
                    <span className="font-medium">{flag.code}</span>
                    <span className="text-[9px] opacity-60">{flag.level}</span>
                  </div>
                  <div className="mt-0.5 opacity-90">{flag.message}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Sub-node stats for non-action nodes ── */}
        {!isAction && (
          <div>
            <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Sub-nodes</h4>
            <div className="rounded-md border border-border/40 px-2 py-1.5 text-xs">
              <div className="text-muted-foreground text-[10px]">{node.type === 'project' ? 'Features' : node.type === 'feature' ? 'Goals' : 'Actions'}</div>
              <div className="font-medium">{node.children.length}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// LiveFeed — displays real-time ACP events for a running AgentRun
// ---------------------------------------------------------------------------

const LIVE_FEED_EVENT_TYPES = new Set([
  'agent_message',
  'artifact_proposed',
  'artifact_applied',
  'intent_interpreted',
  'run_blocked',
  'run_completed',
  'run_failed',
])

// 聚合后的展示项：连续的 agent_message chunk 合并为一段文字
interface FeedItem {
  key: string
  type: CoordinatesRunEvent['type']
  text: string
}

function aggregateFeed(events: CoordinatesRunEvent[]): FeedItem[] {
  const items: FeedItem[] = []
  let buffer: { key: string; parts: string[] } | null = null

  const flush = () => {
    if (buffer && buffer.parts.length > 0) {
      items.push({ key: buffer.key, type: 'agent_message', text: buffer.parts.join('') })
    }
    buffer = null
  }

  for (const e of events) {
    if (!LIVE_FEED_EVENT_TYPES.has(e.type)) continue
    const msg = e.payload?.message ?? e.payload?.reason
    if (!msg) continue
    // 保留 thought 内容，前缀提示；但依旧与普通 agent_message 分段（以避免混入）
    if (e.type === 'agent_message') {
      if (!buffer) buffer = { key: `${e.ts}-${items.length}`, parts: [] }
      buffer.parts.push(msg)
    } else {
      flush()
      items.push({ key: `${e.ts}-${items.length}`, type: e.type, text: msg })
    }
  }
  flush()
  return items
}

function liveFeedIcon(type: CoordinatesRunEvent['type']): string {
  if (type === 'artifact_applied') return '✓'
  if (type === 'artifact_proposed') return '⚙'
  if (type === 'run_failed') return '!'
  if (type === 'run_completed') return '✓'
  if (type === 'intent_interpreted') return '◈'
  return '›'
}

function liveFeedColor(type: CoordinatesRunEvent['type']): string {
  if (type === 'artifact_applied') return 'text-success'
  if (type === 'artifact_proposed') return 'text-primary'
  if (type === 'run_failed') return 'text-destructive'
  if (type === 'run_completed') return 'text-success'
  if (type === 'intent_interpreted') return 'text-warning'
  return 'text-foreground/70'
}

function LiveFeed({ events, isRunning }: { events: CoordinatesRunEvent[]; isRunning: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const feedItems = useMemo(() => aggregateFeed(events), [events])

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [feedItems.length])

  const title = isRunning ? 'Agent Output (streaming)' : 'Agent Output'

  if (feedItems.length === 0) {
    return (
      <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          <Zap size={10} className={isRunning ? 'animate-pulse' : ''} />
          {title}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {isRunning ? 'Waiting for agent output...' : 'No agent output captured.'}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-primary/20 bg-primary/5">
      <div className="flex items-center gap-1.5 border-b border-primary/15 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-primary">
        <Zap size={10} className={isRunning ? 'animate-pulse' : ''} />
        {title}
        <span className="ml-auto text-[9px] text-muted-foreground">{feedItems.length} segments</span>
      </div>
      <div
        ref={scrollRef}
        className="max-h-[320px] overflow-y-auto px-3 py-2 space-y-2"
      >
        {feedItems.map((item, idx) => {
          const isLastAgentMsg =
            item.type === 'agent_message' && idx === feedItems.length - 1
          return (
            <div key={item.key} className="flex items-start gap-1.5">
              <span className={`shrink-0 mt-0.5 text-[10px] font-mono ${liveFeedColor(item.type)}`}>
                {liveFeedIcon(item.type)}
              </span>
              {item.type === 'agent_message' ? (
                <Streamdown
                  className="feed-prose min-w-0 flex-1 break-words"
                  parseIncompleteMarkdown
                  mode={isRunning && isLastAgentMsg ? 'streaming' : 'static'}
                  controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
                  lineNumbers={false}
                >
                  {item.text}
                </Streamdown>
              ) : (
                <span className="whitespace-pre-wrap break-words text-[11px] text-foreground/90 leading-relaxed">
                  {item.text}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RunEventList — 历史 run 展开后的 agent output 列表（无外层 callout）
// ---------------------------------------------------------------------------
function RunEventList({ events, isStreaming }: { events: CoordinatesRunEvent[]; isStreaming: boolean }) {
  const items = useMemo(() => aggregateFeed(events), [events])

  if (items.length === 0) {
    return (
      <div className="rounded border border-border/30 bg-background/40 px-2 py-1.5 text-[11px] italic text-muted-foreground">
        No renderable output.
      </div>
    )
  }

  return (
    <div className="max-h-[280px] overflow-y-auto rounded border border-border/30 bg-background/40 px-2 py-1.5 space-y-1.5">
      {items.map((item, idx) => {
        const isLastAgentMsg = item.type === 'agent_message' && idx === items.length - 1
        return (
          <div key={item.key} className="flex items-start gap-1.5">
            <span className={`shrink-0 mt-0.5 text-[10px] font-mono ${liveFeedColor(item.type)}`}>
              {liveFeedIcon(item.type)}
            </span>
            {item.type === 'agent_message' ? (
              <Streamdown
                className="feed-prose min-w-0 flex-1 break-words"
                parseIncompleteMarkdown
                mode={isStreaming && isLastAgentMsg ? 'streaming' : 'static'}
                controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
                lineNumbers={false}
              >
                {item.text}
              </Streamdown>
            ) : (
              <span className="whitespace-pre-wrap break-words text-[11px] text-foreground/90 leading-relaxed">
                {item.text}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
