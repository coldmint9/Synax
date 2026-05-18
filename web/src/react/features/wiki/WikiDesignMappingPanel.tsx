import { ArrowRight, Check, ChevronDown, ChevronUp, Code2, FileText, Loader2, MousePointer2, X } from 'lucide-react'
import { useState } from 'react'
import { useWikiStore } from '../../state/wikiStore'
import { apiFetch } from '../../../lib/api/origin'
import type { WikiBlock } from '../../../lib/contracts/wiki'
import { isProviderNotConfiguredError, LlmProviderRequiredBanner } from '../../components/LlmProviderRequiredBanner'

interface GoalPreview {
  label: string
  summary: string
  rationale: string
}

interface ActionPreview {
  label: string
  summary: string
  targetFiles: string[]
  estimatedScope: 'small' | 'medium' | 'large'
}

interface PlanResult {
  task: { id: string; status: string; actionContextBundleId: string }
  contextBundle: { fileIds: string[]; symbolIds: string[]; constraints: string[] }
  goalPreview: GoalPreview
  actionPreviews: ActionPreview[]
}

const SCOPE_BADGE = {
  small: 'bg-success/15 text-success',
  medium: 'bg-warning/15 text-warning',
  large: 'bg-destructive/15 text-destructive',
} as const

function ActionItem({ action, index }: { action: ActionPreview; index: number }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-lg border border-border/30 bg-card/50 p-2.5 space-y-1.5">
      <div className="flex items-start gap-2">
        <span className="shrink-0 mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[12px] font-medium text-foreground/90">{action.label}</span>
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${SCOPE_BADGE[action.estimatedScope]}`}>
              {action.estimatedScope}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground/70 leading-snug mt-0.5">{action.summary}</p>
        </div>
        {action.targetFiles.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="shrink-0 rounded p-0.5 text-muted-foreground/40 hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        )}
      </div>
      {expanded && action.targetFiles.length > 0 && (
        <div className="pl-6 space-y-0.5">
          {action.targetFiles.map((f, i) => (
            <div key={i} className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
              <FileText size={9} className="shrink-0" />
              <span className="font-mono truncate">{f}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function WikiDesignMappingPanel({ projectId }: { projectId: string }) {
  const snapshot = useWikiStore(s => s.snapshot)
  const selectedDocumentId = useWikiStore(s => s.selectedDocumentId)
  const blocksById = useWikiStore(s => s.blocksById)
  const documents = useWikiStore(s => s.documents)
  const loadLatest = useWikiStore(s => s.loadLatest)
  const loadPatches = useWikiStore(s => s.loadPatches)

  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([])
  const [instruction, setInstruction] = useState('')
  const [planning, setPlanning] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [planResult, setPlanResult] = useState<PlanResult | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'planned' | 'running' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const doc = documents.find(d => d.id === selectedDocumentId)
  const docBlocks = doc
    ? doc.blockIds.map(id => blocksById[id]).filter((b): b is WikiBlock => Boolean(b))
    : []

  function toggleBlock(blockId: string) {
    setSelectedBlockIds(ids =>
      ids.includes(blockId) ? ids.filter(id => id !== blockId) : [...ids, blockId]
    )
  }

  function getBlockLabel(block: WikiBlock): string {
    const c = block.content as Record<string, unknown>
    if (block.blockType === 'heading') return (c.text as string) ?? 'Heading'
    if (block.blockType === 'paragraph') return ((c.text as string) ?? '').slice(0, 50)
    return block.blockType
  }

  async function handlePlan() {
    if (!snapshot || !instruction.trim()) return
    setPlanning(true)
    setError(null)
    try {
      const res = await apiFetch('/api/wiki/design-mapping/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          snapshotId: snapshot.id,
          selectedBlockIds,
          selectedText: selectedBlockIds
            .map(id => getBlockLabel(blocksById[id]))
            .join(' / '),
          instruction: instruction.trim(),
        }),
      })
      if (!res.ok) throw new Error(`Plan failed: ${res.status}`)
      const result = await res.json() as PlanResult
      setPlanResult(result)
      setTaskId(result.task.id)
      setStatus('planned')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Plan failed')
    } finally {
      setPlanning(false)
    }
  }

  async function handleConfirm() {
    if (!taskId) return
    setConfirming(true)
    setStatus('running')
    try {
      const res = await apiFetch(`/api/wiki/design-mapping/${taskId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error(`Confirm failed: ${res.status}`)
      setStatus('done')
      // Reload wiki state after ACP execution
      await new Promise(r => setTimeout(r, 1500))
      await loadLatest(projectId)
      await loadPatches(projectId, 'pending')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirm failed')
      setStatus('error')
    } finally {
      setConfirming(false)
    }
  }

  function handleReset() {
    setSelectedBlockIds([])
    setInstruction('')
    setPlanResult(null)
    setTaskId(null)
    setStatus('idle')
    setError(null)
  }

  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[11px] text-muted-foreground/40">需要先生成 Wiki</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-3 py-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Design Mapping
      </div>

      {status === 'idle' && (
        <>
          {/* Block selector */}
          {docBlocks.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground/50">选择相关 blocks（可选）</div>
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {docBlocks.map(block => (
                  <button
                    key={block.id}
                    type="button"
                    onClick={() => toggleBlock(block.id)}
                    className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] transition-colors ${
                      selectedBlockIds.includes(block.id)
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground/70 hover:bg-secondary/50'
                    }`}
                  >
                    <MousePointer2 size={9} className="shrink-0" />
                    <span className="truncate">{getBlockLabel(block)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Instruction input */}
          <div className="space-y-1.5">
            <div className="text-[10px] text-muted-foreground/50">设计指令</div>
            <textarea
              className="w-full resize-none rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-[12px] text-foreground leading-relaxed focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 min-h-[72px]"
              placeholder="描述你想要实现的设计变更…"
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
            />
          </div>

          {error && (
            isProviderNotConfiguredError(error) ? (
              <LlmProviderRequiredBanner error={error} onDismiss={() => setError(null)} />
            ) : (
              <p className="text-[11px] text-destructive">{error}</p>
            )
          )}

          <button
            type="button"
            onClick={handlePlan}
            disabled={planning || !instruction.trim()}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-primary/15 px-3 py-2 text-[12px] font-medium text-primary hover:bg-primary/25 transition-colors disabled:opacity-40"
          >
            {planning ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
            {planning ? '生成计划中…' : '生成 Goal / Actions'}
          </button>
        </>
      )}

      {status === 'planned' && planResult && (
        <>
          {/* Goal */}
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-1.5">
            <div className="text-[10px] font-medium uppercase tracking-wider text-primary/70">Goal</div>
            <div className="text-[12px] font-semibold text-foreground/90">{planResult.goalPreview.label}</div>
            <p className="text-[11px] text-foreground/70 leading-snug">{planResult.goalPreview.summary}</p>
            {planResult.goalPreview.rationale && (
              <p className="text-[10px] text-muted-foreground/60 italic">{planResult.goalPreview.rationale}</p>
            )}
          </div>

          {/* Actions */}
          <div className="space-y-1.5">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Actions ({planResult.actionPreviews.length})
            </div>
            {planResult.actionPreviews.map((action, i) => (
              <ActionItem key={i} action={action} index={i} />
            ))}
          </div>

          {/* Context summary */}
          {(planResult.contextBundle.fileIds.length > 0 || planResult.contextBundle.constraints.length > 0) && (
            <div className="rounded-lg border border-border/30 bg-card/40 p-2.5 space-y-1">
              <div className="text-[10px] text-muted-foreground/50">Context Bundle</div>
              {planResult.contextBundle.fileIds.length > 0 && (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
                  <Code2 size={9} />
                  <span>{planResult.contextBundle.fileIds.length} files</span>
                </div>
              )}
            </div>
          )}

          {error && (
            isProviderNotConfiguredError(error)
              ? <LlmProviderRequiredBanner error={error} onDismiss={() => setError(null)} />
              : <p className="text-[11px] text-destructive">{error}</p>
          )}

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirming}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {confirming ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {confirming ? '执行中…' : '确认执行'}
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="rounded-lg px-3 py-2 text-[12px] text-muted-foreground hover:bg-secondary transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        </>
      )}

      {status === 'running' && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 size={20} className="animate-spin text-primary/60" />
          <p className="text-[12px] text-muted-foreground/60 text-center">
            ACP Agent 执行中…
            <br />
            <span className="text-[10px]">完成后自动进入 Wiki preview</span>
          </p>
        </div>
      )}

      {status === 'done' && (
        <div className="flex flex-col items-center gap-3 py-8">
          <div className="rounded-full bg-success/15 p-3">
            <Check size={20} className="text-success" />
          </div>
          <p className="text-[12px] text-foreground/70 text-center">执行完成，Wiki 已更新</p>
          <button
            type="button"
            onClick={handleReset}
            className="text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            重新开始
          </button>
        </div>
      )}

      {status === 'error' && (
        <div className="space-y-2">
          {isProviderNotConfiguredError(error)
            ? <LlmProviderRequiredBanner error={error} onDismiss={() => setError(null)} />
            : <p className="text-[11px] text-destructive">{error}</p>
          }
          <button
            type="button"
            onClick={handleReset}
            className="text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            重试
          </button>
        </div>
      )}
    </div>
  )
}
