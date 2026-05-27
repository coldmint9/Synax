import { useWikiStore } from '../../state/wikiStore'
import WikiDraftCard from './WikiDraftCard'

export default function WikiDraftList() {
  const draftsById = useWikiStore(s => s.draftsById)
  const documents = useWikiStore(s => s.documents)
  const loading = useWikiStore(s => s.loading.drafts)

  const activeDrafts = Object.values(draftsById).filter(
    d => d.status === 'ready' || d.status === 'generating' || d.status === 'partially_applied'
  )

  const docTitleMap = new Map(documents.map(d => [d.id, d.title]))

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-secondary/40" />
        ))}
      </div>
    )
  }

  if (activeDrafts.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-[11px] text-muted-foreground/50">No pending drafts</p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border/40 px-3 py-2">
        <h3 className="text-[11px] font-medium text-muted-foreground">
          Refresh Drafts ({activeDrafts.length})
        </h3>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {activeDrafts.map(draft => (
          <WikiDraftCard
            key={draft.id}
            draft={draft}
            documentTitle={docTitleMap.get(draft.documentId) ?? 'Unknown'}
          />
        ))}
      </div>
    </div>
  )
}
