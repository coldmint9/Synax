import { ArrowLeft } from 'lucide-react'
import { useWikiStore } from '../../state/wikiStore'
import WikiDraftDocumentChange from './WikiDraftDocumentChange'
import WikiDraftActions from './WikiDraftActions'

export default function WikiDraftDetail() {
  const selectedDraftId = useWikiStore(s => s.selectedDraftId)
  const draftsById = useWikiStore(s => s.draftsById)
  const documents = useWikiStore(s => s.documents)
  const backToDraftList = useWikiStore(s => s.backToDraftList)
  const selectedDocumentIds = useWikiStore(s => s.draftSelectedDocumentIds)

  const draft = selectedDraftId ? draftsById[selectedDraftId] : null
  if (!draft) return null

  const doc = documents.find(d => d.id === draft.documentId)
  const checked = selectedDocumentIds[draft.id] ?? []

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border/40 px-3 py-2">
        <button
          type="button"
          onClick={backToDraftList}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={12} />
          <span>Back</span>
        </button>
        <h3 className="mt-1 text-[12px] font-medium text-foreground">
          {doc?.title ?? 'Unknown Document'}
        </h3>
        {draft.summary && (
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
            {draft.summary}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {draft.changes.map(change => (
          <WikiDraftDocumentChange
            key={change.documentId}
            change={change}
            draftId={draft.id}
            checked={checked.includes(change.documentId)}
          />
        ))}
      </div>

      <WikiDraftActions draftId={draft.id} checkedCount={checked.length} />
    </div>
  )
}
