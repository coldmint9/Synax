import { useMemo, useState } from 'react'
import { BookOpen, Folder, FolderOpen } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import type { WikiDocument } from '../../../lib/contracts/wiki'
import { buildWikiDocumentTree, type WikiDocTreeNode } from './buildWikiDocumentTree'

const INDENT_BASE = 10
const INDENT_STEP = 14
/** folder icon (12px) + gap-1.5 (6px) — aligns doc text with section titles */
const FOLDER_ICON_OFFSET = 18

function indentPx(depth: number): number {
  return INDENT_BASE + depth * INDENT_STEP
}

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
      style={{ paddingLeft: `${indentPx(depth) + FOLDER_ICON_OFFSET}px` }}
      className={`group flex w-full items-center gap-1 border-l-2 py-1.5 pr-2.5 text-left text-[13px] leading-snug transition-colors duration-150 ${
        isSelected
          ? 'border-l-primary bg-primary/8 text-primary'
          : 'border-l-transparent hover:bg-secondary/40'
      } ${
        isEmpty
          ? 'text-muted-foreground/45 italic'
          : isSelected
            ? ''
            : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <span className="min-w-0 flex-1 break-words">{doc.title}</span>
      <span className="flex shrink-0 items-center gap-1">
        {draftInfo && draftInfo.count > 0 && (
          <span
            className={`rounded-full px-1.5 py-px text-[9px] font-medium text-white ${
              draftInfo.status === 'generating'
                ? 'animate-pulse bg-primary'
                : draftInfo.status === 'partially_applied'
                  ? 'bg-amber-400'
                  : 'bg-primary'
            }`}
          >
            {draftInfo.status === 'generating' ? '·' : draftInfo.count}
          </span>
        )}
        {(issueCount ?? 0) > 0 && (
          <span className="rounded-full bg-amber-400/80 px-1.5 py-px text-[9px] font-medium text-white">
            {issueCount}
          </span>
        )}
      </span>
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
  const FolderIcon = hasChildren && expanded ? FolderOpen : Folder

  const content = (
    <>
      <FolderIcon size={12} className="shrink-0 text-muted-foreground/50 transition-colors duration-150" />
      <span className="min-w-0 flex-1 truncate text-left">{title}</span>
    </>
  )

  const rowClass =
    'flex w-full items-center gap-1.5 py-1.5 pr-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70'

  if (hasChildren) {
    return (
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        style={{ paddingLeft: `${indentPx(depth)}px` }}
        className={`${rowClass} transition-colors duration-150 hover:text-muted-foreground`}
      >
        {content}
      </button>
    )
  }

  return (
    <div style={{ paddingLeft: `${indentPx(depth)}px` }} className={rowClass}>
      {content}
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
    <div className={isSection && depth === 0 ? 'mt-2 first:mt-0' : undefined}>
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
        <div className="space-y-px">
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
        <div className="mb-2 rounded-lg bg-secondary/30 px-3 py-2">
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <BookOpen size={10} className="shrink-0" />
            <span className="truncate">{snapshot.branch}</span>
            <span className="opacity-40">·</span>
            <span className="opacity-70">{snapshot.headCommitSha.slice(0, 7)}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px]">
            <span className="text-muted-foreground">rev {snapshot.revision}</span>
            {draftsSummary.ready > 0 && (
              <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-primary">
                {draftsSummary.ready} ready
              </span>
            )}
            {draftsSummary.generating > 0 && (
              <span className="animate-pulse rounded-full bg-primary/15 px-1.5 py-0.5 text-primary">
                {draftsSummary.generating} generating
              </span>
            )}
          </div>
        </div>
      )}

      <div className="space-y-px">
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
          <p className="text-[12px] text-muted-foreground/40">{t('wikiNoDocuments')}</p>
        </div>
      )}
    </div>
  )
}
