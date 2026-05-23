import { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, ListChecks, Loader2 } from 'lucide-react'
import { useWikiStore } from '../../state/wikiStore'
import { useShellStore } from '../../state/shellStore'
import { evaluationApi, type WikiEvaluation } from '../../../lib/api/evaluation'

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return new Date(dateStr).toLocaleDateString()
}

const statusDot: Record<WikiEvaluation['status'], string> = {
  active: 'bg-amber-400',
  planned: 'bg-blue-400',
  resolved: 'bg-emerald-400',
}

interface Props {
  blockId: string
  projectId: string
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}

function IssueItem({ ev, onDelete }: { ev: WikiEvaluation; onDelete: (id: string) => void }) {
  return (
    <div className="group/item flex items-start gap-2 px-3 py-2.5 border-b border-border/10 last:border-0">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusDot[ev.status]}`} />
      <div className="flex-1 min-w-0">
        <p className="text-[11px] leading-relaxed text-foreground/85 line-clamp-3">{ev.content}</p>
        <span className="text-[10px] text-muted-foreground/50 mt-0.5 block">
          {relativeTime(ev.createdAt)} · {ev.status}
        </span>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(ev.id) }}
        className="shrink-0 rounded p-0.5 text-muted-foreground/30 opacity-0 group-hover/item:opacity-100 hover:text-destructive transition-all"
      >
        <X size={10} />
      </button>
    </div>
  )
}

function IssueInput({ projectId, blockId, onCreated }: { projectId: string; blockId: string; onCreated: () => void }) {
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    if (!content.trim()) return
    setSubmitting(true)
    try {
      await evaluationApi.create(projectId, blockId, content.trim())
      setContent('')
      onCreated()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-2.5 border-t border-border/15">
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        placeholder="描述问题或建议..."
        rows={2}
        className="w-full resize-none rounded-lg border border-border/20 bg-background/40 px-2.5 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:border-primary/40 focus:outline-none"
        onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) void handleSubmit() }}
      />
      <div className="flex items-center justify-end mt-1.5">
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!content.trim() || submitting}
          className="rounded-full bg-primary/90 px-3 py-1 text-[10px] font-medium text-primary-foreground hover:bg-primary transition-colors disabled:opacity-40"
        >
          {submitting ? '...' : '⌘↵ 提交'}
        </button>
      </div>
    </div>
  )
}

export default function IssuePopover({ blockId, projectId, anchorRef, onClose }: Props) {
  const evaluations = useWikiStore(s => s.evaluations)
  const loadEvaluations = useWikiStore(s => s.loadEvaluations)
  const snapshot = useWikiStore(s => s.snapshot)
  const project = useShellStore(s => s.projects.find(p => p.id === projectId))
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const [generating, setGenerating] = useState(false)

  const blockIssues = evaluations.filter(e => e.blockId === blockId)

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const spaceRight = window.innerWidth - rect.right
    const left = spaceRight > 340 ? rect.right + 8 : rect.left - 328
    const top = Math.min(rect.top, window.innerHeight - 420)
    setPos({ top: Math.max(8, top), left: Math.max(8, left) })
  }, [anchorRef])

  useLayoutEffect(() => { updatePosition() }, [updatePosition])

  useEffect(() => {
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [updatePosition])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popoverRef.current?.contains(e.target as Node)) return
      if (anchorRef.current?.contains(e.target as Node)) return
      onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose, anchorRef])

  async function handleDelete(id: string) {
    await evaluationApi.delete(id)
    await loadEvaluations(projectId)
  }

  async function handleGeneratePlan() {
    if (!snapshot || !project?.source?.localPath) return
    setGenerating(true)
    try {
      await evaluationApi.generatePlan(projectId, snapshot.id, project.source.localPath)
    } finally {
      setGenerating(false)
    }
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="wiki-issue-popover"
      style={{ top: pos.top, left: pos.left }}
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[11px] font-semibold text-foreground/80">
          Issues {blockIssues.length > 0 && `(${blockIssues.length})`}
        </span>
        {blockIssues.length > 0 && (
          <button
            type="button"
            onClick={() => void handleGeneratePlan()}
            disabled={generating}
            className="flex items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors disabled:opacity-40"
          >
            {generating ? <Loader2 size={9} className="animate-spin" /> : <ListChecks size={9} />}
            规划
          </button>
        )}
      </div>
      {blockIssues.length > 0 && (
        <div className="max-h-[220px] overflow-y-auto border-t border-border/10">
          {blockIssues.map(ev => (
            <IssueItem key={ev.id} ev={ev} onDelete={handleDelete} />
          ))}
        </div>
      )}
      <IssueInput projectId={projectId} blockId={blockId} onCreated={() => void loadEvaluations(projectId)} />
    </div>,
    document.body
  )
}
