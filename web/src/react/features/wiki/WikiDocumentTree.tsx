import { BookOpen, ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { useState } from 'react'
import { useWikiStore } from '../../state/wikiStore'
import type { WikiDocument } from '../../../lib/contracts/wiki'

const DOC_TYPE_LABELS: Record<string, string> = {
  overview: '概览',
  architecture: '架构',
  tech_stack: '技术栈',
  module_design: '模块设计',
  data_model: '数据模型',
  api: 'API',
  flow: '流程',
  risk: '风险',
  decision: '决策',
}

function DocItem({
  doc,
  isSelected,
  onSelect,
  depth,
  children,
}: {
  doc: WikiDocument
  isSelected: boolean
  onSelect: () => void
  depth: number
  children?: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = Boolean(children)

  return (
    <div>
      <button
        type="button"
        onClick={onSelect}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        className={`group flex w-full items-center gap-1.5 rounded-lg pr-2.5 py-1.5 text-left text-[12px] transition-colors ${
          isSelected
            ? 'bg-primary/15 text-primary'
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
        <span className="min-w-0 flex-1 truncate leading-snug">{doc.title}</span>
        <span
          className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
            isSelected ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground/70'
          }`}
        >
          {DOC_TYPE_LABELS[doc.docType] ?? doc.docType}
        </span>
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
}: {
  docs: WikiDocument[]
  allDocs: WikiDocument[]
  selectedDocumentId: string | null
  onSelect: (id: string) => void
  depth: number
}) {
  return (
    <>
      {docs.map(doc => {
        const children = allDocs.filter(d => d.parentId === doc.id).sort((a, b) => a.sortOrder - b.sortOrder)
        return (
          <DocItem
            key={doc.id}
            doc={doc}
            isSelected={selectedDocumentId === doc.id}
            onSelect={() => onSelect(doc.id)}
            depth={depth}
          >
            {children.length > 0 ? (
              <DocTree
                docs={children}
                allDocs={allDocs}
                selectedDocumentId={selectedDocumentId}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ) : undefined}
          </DocItem>
        )
      })}
    </>
  )
}

export default function WikiDocumentTree() {
  const documents = useWikiStore(s => s.documents)
  const selectedDocumentId = useWikiStore(s => s.selectedDocumentId)
  const selectDocument = useWikiStore(s => s.selectDocument)
  const snapshot = useWikiStore(s => s.snapshot)
  const patchesSummary = useWikiStore(s => s.patchesSummary)

  const roots = documents.filter(d => !d.parentId).sort((a, b) => a.sortOrder - b.sortOrder)

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto px-2 py-3">
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
            {patchesSummary.pending > 0 && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">
                {patchesSummary.pending} pending
              </span>
            )}
            {patchesSummary.conflict > 0 && (
              <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-destructive">
                {patchesSummary.conflict} conflict
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
        />
      </div>

      {documents.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
          <BookOpen size={20} className="text-muted-foreground/30" />
          <p className="text-[11px] text-muted-foreground/50">暂无文档</p>
        </div>
      )}
    </div>
  )
}
