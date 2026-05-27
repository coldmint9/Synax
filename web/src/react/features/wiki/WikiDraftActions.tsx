import { Eye, EyeOff } from 'lucide-react'
import { useWikiStore } from '../../state/wikiStore'

export default function WikiDraftActions({
  draftId,
  checkedCount,
}: {
  draftId: string
  checkedCount: number
}) {
  const applyDraft = useWikiStore(s => s.applyDraft)
  const discardDraft = useWikiStore(s => s.discardDraft)
  const enterDraftPreview = useWikiStore(s => s.enterDraftPreview)
  const exitDraftPreview = useWikiStore(s => s.exitDraftPreview)
  const draftPreviewActive = useWikiStore(s => s.draftPreviewActive)
  const draftPreviewId = useWikiStore(s => s.draftPreviewId)
  const selectedBlockIds = useWikiStore(s => s.draftSelectedBlockIds)
  const draft = useWikiStore(s => s.draftsById[draftId])

  const totalCount = draft?.changes.length ?? 0
  const isAllSelected = checkedCount === totalCount
  const blockIds = selectedBlockIds[draftId] ?? []
  const isPreviewing = draftPreviewActive && draftPreviewId === draftId

  const handleApply = () => {
    if (isAllSelected) {
      applyDraft(draftId)
    } else {
      applyDraft(draftId, blockIds)
    }
  }

  const handlePreviewToggle = () => {
    if (isPreviewing) {
      exitDraftPreview()
    } else {
      enterDraftPreview(draftId)
    }
  }

  return (
    <div className="border-t border-border/40 px-3 py-2.5 flex items-center gap-2">
      <button
        type="button"
        onClick={handlePreviewToggle}
        className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
          isPreviewing
            ? 'bg-amber-500/15 text-amber-600 hover:bg-amber-500/25'
            : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
        }`}
      >
        {isPreviewing ? <EyeOff size={11} /> : <Eye size={11} />}
        {isPreviewing ? 'Exit' : 'Preview'}
      </button>
      <button
        type="button"
        onClick={handleApply}
        disabled={checkedCount === 0}
        className="flex-1 rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Apply{!isAllSelected && checkedCount > 0 ? ` (${checkedCount})` : ' All'}
      </button>
      <button
        type="button"
        onClick={() => discardDraft(draftId)}
        className="rounded-md bg-secondary px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        Discard
      </button>
    </div>
  )
}
