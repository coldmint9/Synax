import { AlertTriangle, FileText, Loader2, Lock, MessageCircle, Pencil, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Button, TextArea } from '@heroui/react'
import { WikiMarkdown } from './WikiMarkdown'
import { evaluationApi, type WikiEvaluation } from '../../../lib/api/evaluation'
import type { WikiDocument, WikiDocType, WikiManualState, WikiReference, WikiStaleState } from '../../../lib/contracts/wiki'
import { configApi } from '../../../lib/api/config'
import { handleError } from '../../../lib/errors'
import { useLocale } from '../../../hooks/useLocale'
import { useShellStore } from '../../state/shellStore'
import { useWikiStore } from '../../state/wikiStore'
import { useSearchHighlight } from './useSearchHighlight'
import './wiki-theme.css'

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

const statusDot: Record<WikiEvaluation['status'], string> = {
  active: 'bg-amber-400',
  planned: 'bg-blue-400',
  resolved: 'bg-emerald-400',
}

function DocumentIssues({ documentId, projectId }: { documentId: string; projectId: string }) {
  const evaluations = useWikiStore(s => s.evaluations)
  const loadEvaluations = useWikiStore(s => s.loadEvaluations)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const docIssues = evaluations.filter(e => e.documentId === documentId)

  async function handleSubmit() {
    if (!content.trim()) return
    setSubmitting(true)
    try {
      await evaluationApi.create(projectId, documentId, content.trim())
      setContent('')
      await loadEvaluations(projectId)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    await evaluationApi.delete(id)
    await loadEvaluations(projectId)
  }

  return (
    <div className="mt-4 rounded-lg border border-border/30 bg-card/30">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        <MessageCircle size={12} />
        <span>Issues ({docIssues.length})</span>
      </button>

      {expanded && (
        <div className="border-t border-border/20">
          {docIssues.length > 0 && (
            <div className="max-h-[160px] overflow-y-auto border-b border-border/10">
              {docIssues.map(ev => (
                <div key={ev.id} className="group/item flex items-start gap-2 px-3 py-2 border-b border-border/5 last:border-0">
                  <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${statusDot[ev.status]}`} />
                  <p className="flex-1 min-w-0 text-[11px] text-foreground/80 leading-relaxed">{ev.content}</p>
                  <button
                    type="button"
                    onClick={() => void handleDelete(ev.id)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground/30 opacity-0 group-hover/item:opacity-100 hover:text-destructive transition-all"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2 p-2.5">
            <TextArea
              ref={textareaRef}
              aria-label="Issue description"
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="Add issue for this document…"
              rows={1}
              className="flex-1 text-[12px]"
              onKeyDown={e => {
                if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); void handleSubmit() }
              }}
            />
            <Button
              size="sm"
              variant="primary"
              isDisabled={!content.trim() || submitting}
              onPress={() => void handleSubmit()}
            >
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
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
  const evaluations = useWikiStore(s => s.evaluations)

  const previewDraft = draftPreviewActive && draftPreviewId ? draftsById[draftPreviewId] : null
  const previewChange = useMemo(() => {
    if (!previewDraft || previewDraft.documentId !== document.id) return null
    return previewDraft.changes.find(c => c.documentId === document.id) ?? null
  }, [previewDraft, document.id])

  const contentMd = previewChange?.newContentMd ?? document.contentMd
  const issueCount = evaluations.filter(e => e.documentId === document.id).length
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
          {issueCount > 0 && (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400/80 px-1 text-[9px] font-bold text-white">
              {issueCount}
            </span>
          )}
        </div>
        <h1 className="wiki-doc-title">{document.title}</h1>
        {previewChange && (
          <p className="mt-2 text-[11px] text-amber-600">Draft preview — showing proposed changes</p>
        )}
      </header>

      <div className="wiki-markdown">
        <WikiMarkdown content={contentMd} />
      </div>

      <ReferencesSection references={document.references} projectRoot={projectRoot} />
      <DocumentIssues documentId={document.id} projectId={projectId} />
    </article>
  )
}
