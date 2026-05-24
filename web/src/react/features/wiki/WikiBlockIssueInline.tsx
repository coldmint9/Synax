import { useState, useRef, useEffect } from 'react'
import { X, Loader2 } from 'lucide-react'
import { TextArea, Button } from '@heroui/react'
import { useWikiStore } from '../../state/wikiStore'
import { evaluationApi, type WikiEvaluation } from '../../../lib/api/evaluation'

const statusDot: Record<WikiEvaluation['status'], string> = {
  active: 'bg-amber-400',
  planned: 'bg-blue-400',
  resolved: 'bg-emerald-400',
}

interface Props {
  blockId: string
  projectId: string
  autoFocus?: boolean
}

export default function WikiBlockIssueInline({ blockId, projectId, autoFocus }: Props) {
  const evaluations = useWikiStore(s => s.evaluations)
  const loadEvaluations = useWikiStore(s => s.loadEvaluations)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const blockIssues = evaluations.filter(e => e.blockId === blockId)

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  async function handleSubmit() {
    if (!content.trim()) return
    setSubmitting(true)
    try {
      await evaluationApi.create(projectId, blockId, content.trim())
      setContent('')
      await loadEvaluations(projectId)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    await evaluationApi.delete(id)
    await loadEvaluations(projectId)
  }

  return (
    <div
      className="mt-2 rounded-lg border border-border/20 bg-card/30 overflow-hidden"
      onClick={e => e.stopPropagation()}
    >
      {blockIssues.length > 0 && (
        <div className="max-h-[140px] overflow-y-auto border-b border-border/10">
          {blockIssues.map(ev => (
            <div key={ev.id} className="group/item flex items-start gap-2 px-3 py-2 border-b border-border/5 last:border-0">
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${statusDot[ev.status]}`} />
              <p className="flex-1 min-w-0 text-[11px] text-foreground/80 leading-relaxed line-clamp-2">{ev.content}</p>
              <button
                type="button"
                onClick={() => void handleDelete(ev.id)}
                className="shrink-0 rounded p-0.5 text-muted-foreground/30 opacity-0 group-hover/item:opacity-100 hover:text-destructive transition-all"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 p-2.5">
        <TextArea
          ref={textareaRef}
          aria-label="Issue 描述"
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="描述问题或建议..."
          rows={1}
          className="flex-1 text-[12px]"
          onKeyDown={e => {
            if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); void handleSubmit() }
            if (e.key === 'Escape') { e.preventDefault(); textareaRef.current?.blur() }
            e.stopPropagation()
          }}
        />
        <Button
          size="sm"
          color="primary"
          isIconOnly
          isDisabled={!content.trim() || submitting}
          onPress={() => void handleSubmit()}
          className="shrink-0"
        >
          {submitting ? <Loader2 size={12} className="animate-spin" /> : <span className="text-[10px]">⌘↵</span>}
        </Button>
      </div>
    </div>
  )
}
