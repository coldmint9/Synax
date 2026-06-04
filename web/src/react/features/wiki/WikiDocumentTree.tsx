import { BookOpen, FileText, Globe, Network, Box, Workflow, Database } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import type { WikiDocument, WikiDocType } from '../../../lib/contracts/wiki'

const DOC_TYPE_CONFIG: Record<WikiDocType, { icon: typeof Globe; label: string; color: string }> = {
  landscape: { icon: Globe, label: 'Landscape', color: 'text-emerald-400' },
  topology: { icon: Network, label: 'Topology', color: 'text-sky-400' },
  module: { icon: Box, label: 'Modules', color: 'text-violet-400' },
  flow: { icon: Workflow, label: 'Flows', color: 'text-amber-400' },
  data: { icon: Database, label: 'Data', color: 'text-rose-400' },
}

const DOC_TYPE_ORDER: WikiDocType[] = ['landscape', 'topology', 'module', 'flow', 'data']

function DocItem({
  doc,
  isSelected,
  onSelect,
  issueCount,
  draftInfo,
}: {
  doc: WikiDocument
  isSelected: boolean
  onSelect: () => void
  issueCount?: number
  draftInfo?: { count: number; status: 'ready' | 'generating' | 'partially_applied' }
}) {
  const isEmpty = doc.blockIds.length === 0
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ${
        isSelected
          ? 'bg-primary/15 text-primary'
          : isEmpty
            ? 'text-muted-foreground/50 hover:bg-secondary/30 hover:text-muted-foreground'
            : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
      }`}
    >
      <FileText size={11} className="shrink-0 opacity-60" />
      <span className="min-w-0 flex-1 leading-snug break-words">{doc.title}</span>
      {draftInfo && draftInfo.count > 0 && (
        <span className={`shrink-0 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white ${
          draftInfo.status === 'generating' ? 'bg-primary animate-pulse' :
          draftInfo.status === 'partially_applied' ? 'bg-amber-400' :
          'bg-primary'
        }`}>
          {draftInfo.status === 'generating' ? '·' : draftInfo.count}
        </span>
      )}
      {(issueCount ?? 0) > 0 && (
        <span className="shrink-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400/80 px-1 text-[9px] font-bold text-white">
          {issueCount}
        </span>
      )}
    </button>
  )
}

export default function WikiDocumentTree() {
  const { t } = useLocale()
  const documents = useWikiStore(s => s.documents)
  const selectedDocumentId = useWikiStore(s => s.selectedDocumentId)
  const selectDocument = useWikiStore(s => s.selectDocument)
  const snapshot = useWikiStore(s => s.snapshot)
  const draftsSummary = useWikiStore(s => s.draftsSummary)
  const draftsById = useWikiStore(s => s.draftsById)
  const evaluations = useWikiStore(s => s.evaluations)

  // Compute issue counts per document
  const issuesByDocId = new Map<string, number>()
  if (evaluations.length > 0) {
    const blockToDoc = new Map<string, string>()
    for (const doc of documents) {
      for (const blockId of doc.blockIds) {
        blockToDoc.set(blockId, doc.id)
      }
    }
    for (const ev of evaluations) {
      const docId = blockToDoc.get(ev.blockId)
      if (docId) issuesByDocId.set(docId, (issuesByDocId.get(docId) ?? 0) + 1)
    }
  }

  // Compute draft info per document
  const draftsByDocId = new Map<string, { count: number; status: 'ready' | 'generating' | 'partially_applied' }>()
  for (const draft of Object.values(draftsById)) {
    if (draft.status === 'applied' || draft.status === 'discarded' || draft.status === 'expired') continue
    const existing = draftsByDocId.get(draft.documentId)
    const count = draft.changes.length
    if (!existing) {
      draftsByDocId.set(draft.documentId, { count, status: draft.status as 'ready' | 'generating' | 'partially_applied' })
    } else {
      existing.count += count
      if (draft.status === 'generating') existing.status = 'generating'
    }
  }

  // Group documents by docType
  const grouped = new Map<WikiDocType, WikiDocument[]>()
  for (const docType of DOC_TYPE_ORDER) {
    grouped.set(docType, [])
  }
  for (const doc of documents) {
    const group = grouped.get(doc.docType as WikiDocType)
    if (group) group.push(doc)
    else grouped.get('module')!.push(doc) // fallback unknown types to module
  }

  return (
    <div className="flex h-full flex-col gap-1 px-2 py-3">
      {/* Snapshot meta */}
      {snapshot && (
        <div className="mb-2 rounded-lg border border-border/40 bg-card/60 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <BookOpen size={10} className="shrink-0" />
            <span className="font-mono truncate">{snapshot.branch}</span>
            <span className="opacity-40">·</span>
            <span className="font-mono opacity-70">{snapshot.headCommitSha.slice(0, 7)}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px]">
            <span className="text-muted-foreground">rev {snapshot.revision}</span>
            {draftsSummary.ready > 0 && (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-primary">
                {draftsSummary.ready} ready
              </span>
            )}
            {draftsSummary.generating > 0 && (
              <span className="animate-pulse rounded bg-primary/15 px-1.5 py-0.5 text-primary">
                {draftsSummary.generating} generating
              </span>
            )}
          </div>
        </div>
      )}

      {/* Document groups by docType */}
      <div className="space-y-3">
        {DOC_TYPE_ORDER.map(docType => {
          const docs = grouped.get(docType) ?? []
          if (docs.length === 0) return null
          const config = DOC_TYPE_CONFIG[docType]
          const Icon = config.icon
          return (
            <div key={docType}>
              <div className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${config.color}`}>
                <Icon size={11} />
                <span>{config.label}</span>
                <span className="text-muted-foreground/40 font-normal normal-case">({docs.length})</span>
              </div>
              <div className="mt-0.5 space-y-0.5">
                {docs.sort((a, b) => a.sortOrder - b.sortOrder).map(doc => (
                  <DocItem
                    key={doc.id}
                    doc={doc}
                    isSelected={selectedDocumentId === doc.id}
                    onSelect={() => selectDocument(doc.id)}
                    issueCount={issuesByDocId.get(doc.id)}
                    draftInfo={draftsByDocId.get(doc.id)}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {documents.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
          <BookOpen size={20} className="text-muted-foreground/30" />
          <p className="text-[11px] text-muted-foreground/50">{t('wikiNoDocuments')}</p>
        </div>
      )}
    </div>
  )
}
