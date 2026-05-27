import { BookOpen, ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import type { WikiDocument } from '../../../lib/contracts/wiki'

function DocItem({
  doc,
  isSelected,
  onSelect,
  depth,
  isEmpty,
  issueCount,
  draftInfo,
  children,
}: {
  doc: WikiDocument
  isSelected: boolean
  onSelect: () => void
  depth: number
  isEmpty?: boolean
  issueCount?: number
  draftInfo?: { count: number; status: 'ready' | 'generating' | 'partially_applied' }
  children?: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = Boolean(children)

  return (
    <div>
      <button
        type="button"
        onClick={onSelect}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        className={`group flex w-full items-center gap-1.5 rounded-md pr-2.5 py-1.5 text-left text-[12px] transition-colors ${
          isSelected
            ? 'bg-primary/15 text-primary'
            : isEmpty
              ? 'text-muted-foreground/50 hover:bg-secondary/30 hover:text-muted-foreground'
              : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
        }`}
      >
        {hasChildren ? (
          <span
            role="button"
            tabIndex={-1}
            onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
            className="shrink-0 opacity-60"
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </span>
        ) : (
          <FileText size={11} className="shrink-0 opacity-60" />
        )}
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
      {hasChildren && expanded && (
        <div>{children}</div>
      )}
    </div>
  )
}

function DocTree({
  docs,
  allDocs,
  selectedDocumentId,
  onSelect,
  depth,
  issuesByDocId,
  draftsByDocId,
}: {
  docs: WikiDocument[]
  allDocs: WikiDocument[]
  selectedDocumentId: string | null
  onSelect: (id: string) => void
  depth: number
  issuesByDocId?: Map<string, number>
  draftsByDocId?: Map<string, { count: number; status: 'ready' | 'generating' | 'partially_applied' }>
}) {
  return (
    <>
      {docs.map(doc => {
        const children = allDocs.filter(d => d.parentId === doc.id).sort((a, b) => a.sortOrder - b.sortOrder)

        const isCategoryShell = doc.blockIds.length === 0
        const sameNameChild = isCategoryShell
          ? children.find(c => c.title === doc.title)
          : null

        const effectiveDocId = sameNameChild ? sameNameChild.id : doc.id
        const visibleChildren = sameNameChild
          ? children.filter(c => c.id !== sameNameChild.id)
          : children

        return (
          <DocItem
            key={doc.id}
            doc={doc}
            isSelected={selectedDocumentId === effectiveDocId}
            onSelect={() => onSelect(effectiveDocId)}
            depth={depth}
            isEmpty={isCategoryShell && !sameNameChild}
            issueCount={issuesByDocId?.get(effectiveDocId) ?? 0}
            draftInfo={draftsByDocId?.get(effectiveDocId)}
          >
            {visibleChildren.length > 0 ? (
              <DocTree
                docs={visibleChildren}
                allDocs={allDocs}
                selectedDocumentId={selectedDocumentId}
                onSelect={onSelect}
                depth={depth + 1}
                issuesByDocId={issuesByDocId}
                draftsByDocId={draftsByDocId}
              />
            ) : undefined}
          </DocItem>
        )
      })}
    </>
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

  const roots = documents.filter(d => !d.parentId).sort((a, b) => a.sortOrder - b.sortOrder)

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

      {/* Document tree */}
      <div className="space-y-0.5">
        <DocTree
          docs={roots}
          allDocs={documents}
          selectedDocumentId={selectedDocumentId}
          onSelect={id => selectDocument(id)}
          depth={0}
          issuesByDocId={issuesByDocId}
          draftsByDocId={draftsByDocId}
        />
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
