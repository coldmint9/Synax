import { Loader2, MessageSquarePlus, Trash2, Sparkles, ListChecks } from 'lucide-react'
import { useState } from 'react'
import { useWikiStore } from '../../state/wikiStore'
import { evaluationApi } from '../../../lib/api/evaluation'
import { useShellStore } from '../../state/shellStore'

interface Props {
  projectId: string
  selectedBlockId: string | null
}

export default function WikiEvaluationSidebar({ projectId, selectedBlockId }: Props) {
  const evaluations = useWikiStore(s => s.evaluations)
  const loadEvaluations = useWikiStore(s => s.loadEvaluations)
  const [newContent, setNewContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    if (!selectedBlockId || !newContent.trim()) return
    setSubmitting(true)
    try {
      await evaluationApi.create(projectId, selectedBlockId, newContent.trim())
      setNewContent('')
      await loadEvaluations(projectId)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    await evaluationApi.delete(id)
    await loadEvaluations(projectId)
  }

  const grouped = evaluations.reduce<Record<string, typeof evaluations>>((acc, e) => {
    ;(acc[e.blockId] ??= []).push(e)
    return acc
  }, {})

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/20 px-3">
        <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
          Issues
        </span>
        {evaluations.length > 0 && (
          <span className="rounded-full bg-amber-400/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
            {evaluations.length}
          </span>
        )}
      </div>

      {/* Issue list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {evaluations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <MessageSquarePlus size={20} className="mb-2 text-muted-foreground/20" />
            <p className="text-[11px] text-muted-foreground/40">
              选择一个 Block 后添加 Issue
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {Object.entries(grouped).map(([blockId, issues]) => (
              <div key={blockId} className="rounded-lg border border-border/20 bg-card/40 backdrop-blur-sm">
                <div className="px-2.5 py-1.5 border-b border-border/10">
                  <span className="text-[10px] font-medium text-muted-foreground/50 font-mono truncate">
                    {blockId.slice(0, 8)}
                  </span>
                </div>
                {issues.map(ev => (
                  <div key={ev.id} className="group flex items-start gap-1.5 px-2.5 py-2 border-b border-border/5 last:border-0">
                    <div className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                    <p className="flex-1 text-[11px] text-foreground/80 leading-relaxed">{ev.content}</p>
                    <button
                      type="button"
                      onClick={() => void handleDelete(ev.id)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground/30 opacity-0 group-hover:opacity-100 hover:text-destructive transition-all"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-border/20 p-2">
        <div className="flex flex-col gap-1.5">
          <textarea
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            placeholder={selectedBlockId ? '描述 Issue…' : '先选择一个 Block'}
            disabled={!selectedBlockId}
            rows={2}
            className="w-full resize-none rounded-lg border border-border/30 bg-background/60 px-2.5 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:border-primary/40 focus:outline-none disabled:opacity-40"
            onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) void handleSubmit() }}
          />
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!selectedBlockId || !newContent.trim() || submitting}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary/90 px-2 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary transition-colors disabled:opacity-40"
          >
            <Sparkles size={10} />
            添加 Issue
          </button>
          {evaluations.length > 0 && (
            <GeneratePlanButton projectId={projectId} />
          )}
        </div>
      </div>
    </div>
  )
}

function GeneratePlanButton({ projectId }: { projectId: string }) {
  const snapshot = useWikiStore(s => s.snapshot)
  const project = useShellStore(s => s.projects.find(p => p.id === projectId))
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    if (!snapshot || !project?.source?.localPath) return
    setGenerating(true)
    setError(null)
    try {
      await evaluationApi.generatePlan(projectId, snapshot.id, project.source.localPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => void handleGenerate()}
        disabled={generating || !snapshot}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors disabled:opacity-40"
      >
        {generating ? <Loader2 size={10} className="animate-spin" /> : <ListChecks size={10} />}
        {generating ? '生成中…' : '生成规划'}
      </button>
      {error && (
        <p className="mt-1 text-[10px] text-destructive">{error}</p>
      )}
    </div>
  )
}
