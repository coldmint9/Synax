import { AlertTriangle, FileText, Loader2, Lock, Pencil, Target } from 'lucide-react'
import { useMemo, useState, useEffect, useCallback } from 'react'
import { WikiMarkdown } from './WikiMarkdown'
import type { WikiDocument, WikiDocType, WikiManualState, WikiReference, WikiStaleState } from '../../../lib/contracts/wiki'
import { configApi } from '../../../lib/api/config'
import { handleError } from '../../../lib/errors'
import { useLocale } from '../../../hooks/useLocale'
import { useShellStore } from '../../state/shellStore'
import { useWikiStore } from '../../state/wikiStore'
import { useSearchHighlight } from './useSearchHighlight'
import './wiki-theme.css'

function findNearestHeading(contentMd: string, quote: string): string | undefined {
  const idx = contentMd.indexOf(quote)
  if (idx < 0) return undefined
  const before = contentMd.slice(0, idx)
  const lines = before.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(#{1,6})\s+(.+)$/.exec(lines[i].trim())
    if (m) return m[2].trim()
  }
  return undefined
}

function GoalSelectionToolbar({
  documentId,
  contentMd,
  containerClass,
}: {
  documentId: string
  contentMd: string
  containerClass: string
}) {
  const { t } = useLocale()
  const openGoalInput = useWikiStore(s => s.openGoalInput)
  const [toolbar, setToolbar] = useState<{ x: number; y: number; quote: string } | null>(null)

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setToolbar(null)
      return
    }
    const quote = sel.toString().trim()
    if (quote.length < 3) {
      setToolbar(null)
      return
    }
    const container = document.querySelector(`.${containerClass}`)
    if (!container || !sel.anchorNode || !container.contains(sel.anchorNode)) {
      setToolbar(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setToolbar({ x: rect.left + rect.width / 2, y: rect.top - 10, quote })
  }, [containerClass])

  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [handleMouseUp])

  if (!toolbar) return null

  return (
    <button
      type="button"
      className="fixed z-50 flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-full border border-amber-400/40 bg-background/95 px-2.5 py-1 text-[10px] font-medium text-amber-600 shadow-md backdrop-blur-sm hover:bg-amber-400/10"
      style={{ left: toolbar.x, top: toolbar.y }}
      onMouseDown={e => e.preventDefault()}
      onClick={() => {
        const heading = findNearestHeading(contentMd, toolbar.quote)
        openGoalInput({
          content: toolbar.quote,
          documentId,
          anchor: { type: 'selection', quote: toolbar.quote, heading },
        })
        setToolbar(null)
        window.getSelection()?.removeAllRanges()
      }}
    >
      <Target size={10} />
      {t('goalAddFromSelection')}
    </button>
  )
}

function StaleBadge({ state }: { state: WikiStaleState }) {
  if (state === 'fresh') return null
  const map = {
    possibly_stale: { label: 'possibly stale', cls: 'bg-warning/15 text-warning' },
    stale: { label: 'stale', cls: 'bg-destructive/15 text-destructive' },
    semantic_review_needed: { label: 'review needed', cls: 'bg-orange-500/15 text-orange-400' },
    conflict: { label: 'conflict', cls: 'bg-destructive/20 text-destructive' },
  } as const
  const { label, cls } = map[state] ?? { label: state, cls: 'bg-secondary text-muted-foreground' }
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${cls}`}>
      <AlertTriangle size={8} />
      {label}
    </span>
  )
}

function ManualBadge({ state }: { state: WikiManualState }) {
  if (state === 'none') return null
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
      state === 'locked' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
    }`}>
      {state === 'locked' ? <Lock size={8} /> : <Pencil size={8} />}
      {state}
    </span>
  )
}

const DOC_TYPE_LABEL: Record<WikiDocType, string> = {
  landscape: 'landscape',
  topology: 'topology',
  module: 'module_spec',
  flow: 'flow',
  data: 'data',
}

function referenceIdentity(ref: WikiReference): string {
  return [
    ref.filePath || 'unknown',
    ref.startLine ?? '',
    ref.endLine ?? '',
    ref.symbol ?? '',
  ].join(':')
}

function resolveProjectFilePath(projectRoot: string, filePath: string): string {
  if (!filePath) return ''
  if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) return filePath
  const root = projectRoot.replace(/[/\\]+$/, '')
  const rel = filePath.replace(/^[/\\]+/, '')
  return `${root}/${rel}`
}

function ReferencesSection({
  references,
  projectRoot,
}: {
  references: WikiDocument['references']
  projectRoot?: string
}) {
  if (references.length === 0) return null

  const uniqueRefs = [...new Map(
    references.map(ref => [referenceIdentity(ref), ref]),
  ).values()]

  async function openReference(ref: WikiReference) {
    if (!projectRoot || !ref.filePath) return
    try {
      await configApi.openFile(
        resolveProjectFilePath(projectRoot, ref.filePath),
        ref.startLine,
      )
    } catch (err) {
      handleError(err)
    }
  }

  return (
    <section className="wiki-references">
      <h3 className="wiki-references-title">
        References
      </h3>
      <ul className="space-y-1.5">
        {uniqueRefs.map((ref, index) => {
          const lineSuffix = ref.startLine
            ? ref.endLine && ref.endLine !== ref.startLine
              ? `:${ref.startLine}-${ref.endLine}`
              : `:${ref.startLine}`
            : ''
          const canOpen = Boolean(projectRoot && ref.filePath)
          return (
            <li key={`${referenceIdentity(ref)}:${index}`}>
              {canOpen ? (
                <button
                  type="button"
                  className="wiki-ref-link"
                  onClick={() => void openReference(ref)}
                  title="Open in editor"
                >
                  <code>
                    {ref.filePath}{lineSuffix}
                  </code>
                </button>
              ) : (
                <code>
                  {ref.filePath}{lineSuffix}
                </code>
              )}
              {ref.symbol && (
                <span className="ml-2 text-[10px] text-muted-foreground/60">{ref.symbol}</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default function WikiDocumentView({
  document,
  projectId,
}: {
  document: WikiDocument
  projectId: string
}) {
  const { t } = useLocale()
  const projectRoot = useShellStore(s => s.projects.find(p => p.id === projectId)?.source?.localPath)
  const snapshot = useWikiStore(s => s.snapshot)
  const searchHighlightQuery = useWikiStore(s => s.searchHighlightQuery)
  const draftPreviewActive = useWikiStore(s => s.draftPreviewActive)
  const draftPreviewId = useWikiStore(s => s.draftPreviewId)
  const draftsById = useWikiStore(s => s.draftsById)

  const previewDraft = draftPreviewActive && draftPreviewId ? draftsById[draftPreviewId] : null
  const previewChange = useMemo(() => {
    if (!previewDraft || previewDraft.documentId !== document.id) return null
    return previewDraft.changes.find(c => c.documentId === document.id) ?? null
  }, [previewDraft, document.id])

  const contentMd = previewChange?.newContentMd ?? document.contentMd
  useSearchHighlight(document.id, searchHighlightQuery, Boolean(contentMd))

  if (!contentMd) {
    const isGenerating = snapshot?.status === 'writing'
      && document.pipelineStage === 'pending'
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        {isGenerating ? (
          <>
            <Loader2 size={20} className="animate-spin text-muted-foreground/30" />
            <p className="text-[12px] text-muted-foreground/50">{t('wikiWritingLabel')}</p>
          </>
        ) : (
          <>
            <FileText size={24} className="text-muted-foreground/20" />
            <p className="text-[12px] text-muted-foreground/40">{t('wikiNoDocuments')}</p>
          </>
        )}
      </div>
    )
  }

  return (
    <article
      id={`wiki-document-${document.id}`}
      className="wiki-doc mx-auto w-full"
    >
      <header className="wiki-doc-header">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="wiki-doc-type-badge">{DOC_TYPE_LABEL[document.docType]}</span>
          <StaleBadge state={document.staleState} />
          <ManualBadge state={document.manualState} />
        </div>
        <h1 className="wiki-doc-title">{document.title}</h1>
        {previewChange && (
          <p className="mt-2 text-[11px] text-amber-600">Draft preview — showing proposed changes</p>
        )}
      </header>

      <div className="wiki-markdown relative">
        <WikiMarkdown content={contentMd} />
        <GoalSelectionToolbar documentId={document.id} contentMd={contentMd} containerClass="wiki-markdown" />
      </div>

      <ReferencesSection references={document.references} projectRoot={projectRoot} />
    </article>
  )
}
