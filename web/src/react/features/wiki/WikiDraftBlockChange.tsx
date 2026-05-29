import { useState } from 'react'
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react'
import { useWikiStore } from '../../state/wikiStore'
import type { DraftBlockChange } from '../../../lib/contracts/wiki'

export default function WikiDraftBlockChange({
  change,
  draftId,
  checked,
}: {
  change: DraftBlockChange
  draftId: string
  checked: boolean
}) {
  const [showReasoning, setShowReasoning] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const toggleDraftBlock = useWikiStore(s => s.toggleDraftBlock)
  const editDraftBlock = useWikiStore(s => s.editDraftBlock)
  const blocksById = useWikiStore(s => s.blocksById)

  const block = blocksById[change.blockId]
  const blockTitle = block?.blockType === 'heading'
    ? String((block.content as { text?: string })?.text ?? change.blockId.slice(0, 8))
    : change.blockId.slice(0, 8)

  const handleEdit = () => {
    const content = typeof change.newContent === 'string'
      ? change.newContent
      : JSON.stringify(change.newContent, null, 2)
    setEditValue(content)
    setEditing(true)
  }

  const handleSaveEdit = () => {
    editDraftBlock(draftId, change.blockId, editValue)
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
          onChange={() => toggleDraftBlock(draftId, change.blockId)}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-foreground">
              {blockTitle}
            </span>
            <span className={`rounded px-1 py-0.5 text-[9px] ${
              change.action === 'delete' ? 'bg-destructive/15 text-destructive' :
              change.action === 'insert_after' ? 'bg-emerald-500/15 text-emerald-600' :
              'bg-primary/15 text-primary'
            }`}>
              {change.action}
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

          {/* Diff display */}
          {!editing && change.action !== 'delete' && (
            <div className="mt-1.5 rounded bg-secondary/30 p-2 text-[10px] font-mono leading-relaxed">
              {change.oldContent ? (
                <div className="text-destructive/70 line-through">
                  {typeof change.oldContent === 'string'
                    ? change.oldContent.slice(0, 200)
                    : JSON.stringify(change.oldContent).slice(0, 200)}
                </div>
              ) : null}
              <div className="text-emerald-600">
                {typeof change.newContent === 'string'
                  ? change.newContent.slice(0, 200)
                  : JSON.stringify(change.newContent).slice(0, 200)}
              </div>
            </div>
          )}

          {change.action === 'delete' && !editing && (
            <div className="mt-1.5 rounded bg-destructive/5 p-2 text-[10px] font-mono text-destructive/70 line-through">
              {typeof change.oldContent === 'string'
                ? change.oldContent.slice(0, 200)
                : JSON.stringify(change.oldContent).slice(0, 200)}
            </div>
          )}

          {/* Edit mode */}
          {editing && (
            <div className="mt-1.5 space-y-1.5">
              <textarea
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                rows={4}
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

          {/* Reasoning toggle */}
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
