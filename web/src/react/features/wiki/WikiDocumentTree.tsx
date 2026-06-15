import { useCallback, useMemo, useState } from 'react'
import { BookOpen, Folder, FolderOpen, Loader2 } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import type { WikiDocument } from '../../../lib/contracts/wiki'
import { buildWikiDocumentTree, type WikiDocTreeNode } from './buildWikiDocumentTree'

const INDENT_BASE = 8
const INDENT_STEP = 12
const FOLDER_ICON_OFFSET = 18

function indentPx(depth: number): number {
  return INDENT_BASE + depth * INDENT_STEP
}

function DocItem({
  doc,
  isSelected,
  isGenerating,
  onSelect,
  issueCount,
  draftInfo,
  depth,
}: {
  doc: WikiDocument
  isSelected: boolean
  isGenerating: boolean
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
      aria-busy={isGenerating}
      style={{ paddingLeft: `${indentPx(depth) + FOLDER_ICON_OFFSET}px` }}
      className={`list-row ${isSelected ? 'list-row--active' : ''} ${isGenerating ? 'list-row--generating' : ''} ${isEmpty && !isSelected && !isGenerating ? 'list-row--empty' : ''}`}
    >
      {isGenerating ? (
        <Loader2 size={12} className="shrink-0 animate-spin text-primary" aria-hidden />
      ) : (
        <span className="w-3 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 break-words">{doc.title}</span>
      <span className="flex shrink-0 items-center gap-1">
        {draftInfo && draftInfo.count > 0 && (
          <span
            className={`list-badge ${draftInfo.status === 'generating' ? 'animate-pulse' : ''} ${
              draftInfo.status === 'partially_applied' ? '!bg-amber-400/20 !text-amber-600' : ''
            }`}
          >
            {draftInfo.status === 'generating' ? '·' : draftInfo.count}
          </span>
        )}
        {(issueCount ?? 0) > 0 && (
          <span className="list-badge !bg-amber-400/20 !text-amber-600">{issueCount}</span>
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
  const FolderIcon = expanded ? FolderOpen : Folder
  const content = (
    <>
      <FolderIcon size={12} className="shrink-0 text-muted-foreground/50" />
      <span className="min-w-0 flex-1 truncate text-left">{title}</span>
    </>
  )

  if (hasChildren) {
    return (
      <button
        type="button"
        aria-expanded={expanded}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        style={{ paddingLeft: `${indentPx(depth)}px` }}
        className="list-row list-row--section"
      >
        {content}
      </button>
    )
  }

  return (
    <div style={{ paddingLeft: `${indentPx(depth)}px` }} className="list-row list-row--section cursor-default">
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
  generatingDocumentId,
  defaultExpanded,
  isExpanded,
  onToggleExpanded,
}: {
  node: WikiDocTreeNode
  depth: number
  selectedDocumentId: string | null
  onSelect: (id: string) => void
  issuesByDocId: Map<string, number>
  draftsByDocId: Map<string, { count: number; status: 'ready' | 'generating' | 'partially_applied' }>
  generatingDocumentId: string | null
  defaultExpanded: boolean
  isExpanded: (id: string, defaultExpanded: boolean) => boolean
  onToggleExpanded: (id: string, defaultExpanded: boolean) => void
}) {
  const hasChildren = node.children.length > 0
  const nodeId = node.document.id
  const expanded = isExpanded(nodeId, defaultExpanded)
  const isSection = node.document.isSection

  return (
    <div className={isSection && depth === 0 ? 'list-section' : undefined}>
      {isSection ? (
        <SectionFolder
          title={node.document.title}
          depth={depth}
          expanded={expanded}
          hasChildren={hasChildren}
          onToggle={() => onToggleExpanded(nodeId, defaultExpanded)}
        />
      ) : (
        <DocItem
          doc={node.document}
          depth={depth}
          isSelected={selectedDocumentId === node.document.id}
          isGenerating={generatingDocumentId === node.document.id}
          onSelect={() => onSelect(node.document.id)}
          issueCount={issuesByDocId.get(node.document.id)}
          draftInfo={draftsByDocId.get(node.document.id)}
        />
      )}
      {hasChildren && expanded && (
        <div className="list-nested">
          {node.children.map(child => (
            <TreeNode
              key={child.document.id}
              node={child}
              depth={depth + 1}
              selectedDocumentId={selectedDocumentId}
              onSelect={onSelect}
              issuesByDocId={issuesByDocId}
              draftsByDocId={draftsByDocId}
              generatingDocumentId={generatingDocumentId}
              defaultExpanded={depth + 1 <= 1}
              isExpanded={isExpanded}
              onToggleExpanded={onToggleExpanded}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function WikiDocumentTree({
  generatingDocumentId = null,
}: {
  generatingDocumentId?: string | null
}) {
  const { t } = useLocale()
  const documents = useWikiStore(s => s.documents)
  const selectedDocumentId = useWikiStore(s => s.selectedDocumentId)
  const selectDocument = useWikiStore(s => s.selectDocument)
  const snapshot = useWikiStore(s => s.snapshot)
  const draftsSummary = useWikiStore(s => s.draftsSummary)
  const draftsById = useWikiStore(s => s.draftsById)
  const evaluations = useWikiStore(s => s.evaluations)

  const tree = useMemo(() => buildWikiDocumentTree(documents), [documents])

  const [expansionState, setExpansionState] = useState<Record<string, boolean>>({})

  const isExpanded = useCallback(
    (id: string, defaultExpanded: boolean) => expansionState[id] ?? defaultExpanded,
    [expansionState],
  )

  const toggleExpanded = useCallback((id: string, defaultExpanded: boolean) => {
    setExpansionState(prev => ({
      ...prev,
      [id]: !(prev[id] ?? defaultExpanded),
    }))
  }, [])

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
    <div className="list-surface h-full">
      {snapshot && (
        <div className="list-meta">
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <BookOpen size={10} className="shrink-0" />
            <span className="truncate">{snapshot.branch}</span>
            <span className="opacity-40">·</span>
            <span className="opacity-70">{snapshot.headCommitSha.slice(0, 7)}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px]">
            <span className="text-muted-foreground">rev {snapshot.revision}</span>
            {draftsSummary.ready > 0 && (
              <span className="list-badge">{draftsSummary.ready} ready</span>
            )}
            {draftsSummary.generating > 0 && (
              <span className="list-badge animate-pulse">{draftsSummary.generating} generating</span>
            )}
          </div>
        </div>
      )}

      <div className="list-nested flex-1">
        {tree.map(node => (
          <TreeNode
            key={node.document.id}
            node={node}
            depth={0}
            selectedDocumentId={selectedDocumentId}
            onSelect={selectDocument}
            issuesByDocId={issuesByDocId}
            draftsByDocId={draftsByDocId}
            generatingDocumentId={generatingDocumentId}
            defaultExpanded
            isExpanded={isExpanded}
            onToggleExpanded={toggleExpanded}
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
