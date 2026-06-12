import { useState } from 'react'
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react'
import { useWikiStore } from '../../state/wikiStore'
import type { DraftDocumentChange } from '../../../lib/contracts/wiki'

export default function WikiDraftDocumentChange({
  change,
  draftId,
  checked,
}: {
  change: DraftDocumentChange
  draftId: string
  checked: boolean
}) {
  const [showReasoning, setShowReasoning] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const toggleDraftChange = useWikiStore(s => s.toggleDraftChange)
  const editDraftChange = useWikiStore(s => s.editDraftChange)

  const handleEdit = () => {
    setEditValue(change.newContentMd ?? '')
    setEditing(true)
  }

  const handleSaveEdit = () => {
    editDraftChange(draftId, change.documentId, editValue)
    setEditing(false)
  }

  return (
    <div className={`rounded-lg border border-border/40 p-2.5 transition-colors ${
      checked ? 'bg-card/60' : 'bg-card/20 opacity-60'
    }`}>
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggleDraftChange(draftId, change.documentId)}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-foreground">
              Document update
            </span>
            {!editing && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleEdit() }}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Pencil size={10} />
              </button>
            )}
          </div>

          {!editing && (
            <div className="mt-1.5 space-y-1.5 rounded bg-secondary/30 p-2 text-[10px] font-mono leading-relaxed max-h-[240px] overflow-y-auto">
              {change.oldContentMd ? (
                <div className="text-destructive/70 whitespace-pre-wrap line-through">
                  {change.oldContentMd.slice(0, 800)}
                  {change.oldContentMd.length > 800 ? '…' : ''}
                </div>
              ) : null}
              {change.newContentMd ? (
                <div className="text-emerald-600 whitespace-pre-wrap">
                  {change.newContentMd.slice(0, 800)}
                  {change.newContentMd.length > 800 ? '…' : ''}
                </div>
              ) : (
                <div className="text-destructive/70 italic">(content removed)</div>
              )}
            </div>
          )}

          {editing && (
            <div className="mt-1.5 space-y-1.5">
              <textarea
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                rows={8}
                className="w-full rounded border border-border bg-background p-2 text-[10px] font-mono focus:border-primary focus:outline-none"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  className="rounded bg-primary px-2 py-0.5 text-[9px] text-white hover:bg-primary/90"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded bg-secondary px-2 py-0.5 text-[9px] text-muted-foreground hover:bg-secondary/80"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {change.reasoning && (
            <button
              type="button"
              onClick={() => setShowReasoning(v => !v)}
              className="mt-1.5 flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground"
            >
              {showReasoning ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
              Reasoning
            </button>
          )}
          {showReasoning && change.reasoning && (
            <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground/80">
              {change.reasoning}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
