import { FileText } from 'lucide-react'
import { useWikiStore } from '../../state/wikiStore'
import type { WikiRefreshDraft } from '../../../lib/contracts/wiki'

export default function WikiDraftCard({
  draft,
  documentTitle,
}: {
  draft: WikiRefreshDraft
  documentTitle: string
}) {
  const selectDraft = useWikiStore(s => s.selectDraft)
  const discardDraft = useWikiStore(s => s.discardDraft)

  const isGenerating = draft.status === 'generating'
  const isPartial = draft.status === 'partially_applied'

  return (
    <button
      type="button"
      onClick={() => !isGenerating && selectDraft(draft.id)}
      disabled={isGenerating}
      className={`group w-full rounded-lg border border-border/40 p-3 text-left transition-colors ${
        isGenerating
          ? 'cursor-default opacity-70'
          : 'hover:border-primary/30 hover:bg-primary/5'
      }`}
    >
      <div className="flex items-start gap-2">
        <FileText size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px] font-medium text-foreground">
              {documentTitle}
            </span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${
              isGenerating ? 'animate-pulse bg-primary/15 text-primary' :
              isPartial ? 'bg-amber-400/15 text-amber-600' :
              'bg-primary/15 text-primary'
            }`}>
              {isGenerating ? 'generating' : isPartial ? 'partial' : 'ready'}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {draft.changes.length} changes
            {draft.summary && ` · ${draft.summary}`}
          </p>
        </div>
      </div>
    </button>
  )
}
