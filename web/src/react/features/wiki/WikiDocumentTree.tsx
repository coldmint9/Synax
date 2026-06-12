import { useMemo, useState } from 'react'
import { BookOpen, ChevronRight, FileText, Folder } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import type { WikiDocument } from '../../../lib/contracts/wiki'
import { buildWikiDocumentTree, type WikiDocTreeNode } from './buildWikiDocumentTree'

function DocItem({
  doc,
  isSelected,
  onSelect,
  issueCount,
  draftInfo,
  depth,
}: {
  doc: WikiDocument
  isSelected: boolean
  onSelect: () => void
  issueCount?: number
  draftInfo?: { count: number; status: 'ready' | 'generating' | 'partially_applied' }
  depth: number
}) {
  const isEmpty = !doc.contentMd
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
      className={`group flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2.5 text-left text-[12px] transition-colors ${
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

function SectionFolder({
  title,
  depth,
  expanded,
  onToggle,
  hasChildren,
}: {
  title: string
  depth: number
  expanded: boolean
  onToggle: () => void
  hasChildren: boolean
}) {
  return (
    <div
      className="flex w-full items-stretch"
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      {hasChildren ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex shrink-0 items-center py-1.5 pr-0.5 text-muted-foreground/50 hover:text-muted-foreground"
        >
          <ChevronRight
            size={11}
            className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
      ) : (
        <span className="w-3.5 shrink-0" aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2.5 text-[12px] font-medium text-muted-foreground/80">
        <Folder size={11} className="shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 leading-snug break-words">{title}</span>
      </div>
    </div>
  )
}

function TreeNode({
  node,
  depth,
  selectedDocumentId,
  onSelect,
  issuesByDocId,
  draftsByDocId,
  defaultExpanded,
}: {
  node: WikiDocTreeNode
  depth: number
  selectedDocumentId: string | null
  onSelect: (id: string) => void
  issuesByDocId: Map<string, number>
  draftsByDocId: Map<string, { count: number; status: 'ready' | 'generating' | 'partially_applied' }>
  defaultExpanded: boolean
}) {
  const hasChildren = node.children.length > 0
  const [expanded, setExpanded] = useState(defaultExpanded)
  const isSection = node.document.isSection

  return (
    <div>
      {isSection ? (
        <SectionFolder
          title={node.document.title}
          depth={depth}
          expanded={expanded}
          hasChildren={hasChildren}
          onToggle={() => setExpanded(v => !v)}
        />
      ) : (
        <DocItem
          doc={node.document}
          depth={depth}
          isSelected={selectedDocumentId === node.document.id}
          onSelect={() => onSelect(node.document.id)}
          issueCount={issuesByDocId.get(node.document.id)}
          draftInfo={draftsByDocId.get(node.document.id)}
        />
      )}
      {hasChildren && expanded && (
        <div className="space-y-0.5">
          {node.children.map(child => (
            <TreeNode
              key={child.document.id}
              node={child}
              depth={depth + 1}
              selectedDocumentId={selectedDocumentId}
              onSelect={onSelect}
              issuesByDocId={issuesByDocId}
              draftsByDocId={draftsByDocId}
              defaultExpanded={depth + 1 <= 1}
            />
          ))}
        </div>
      )}
    </div>
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

  const tree = useMemo(() => buildWikiDocumentTree(documents), [documents])

  const issuesByDocId = useMemo(() => {
    const map = new Map<string, number>()
    for (const ev of evaluations) {
      map.set(ev.documentId, (map.get(ev.documentId) ?? 0) + 1)
    }
    return map
  }, [evaluations])

  const draftsByDocId = useMemo(() => {
    const map = new Map<string, { count: number; status: 'ready' | 'generating' | 'partially_applied' }>()
    for (const draft of Object.values(draftsById)) {
      if (draft.status === 'applied' || draft.status === 'discarded' || draft.status === 'expired') continue
      const existing = map.get(draft.documentId)
      const count = draft.changes.length
      if (!existing) {
        map.set(draft.documentId, { count, status: draft.status as 'ready' | 'generating' | 'partially_applied' })
      } else {
        existing.count += count
        if (draft.status === 'generating') existing.status = 'generating'
      }
    }
    return map
  }, [draftsById])

  return (
    <div className="flex h-full flex-col gap-1 px-2 py-3">
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

      <div className="space-y-0.5">
        {tree.map(node => (
          <TreeNode
            key={node.document.id}
            node={node}
            depth={0}
            selectedDocumentId={selectedDocumentId}
            onSelect={selectDocument}
            issuesByDocId={issuesByDocId}
            draftsByDocId={draftsByDocId}
            defaultExpanded
          />
        ))}
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
