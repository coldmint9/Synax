import { AlertTriangle, FileText, Lock, Loader2, Maximize2, Pencil, X, MessageCircle } from 'lucide-react'
import { useState, useEffect, useMemo, memo } from 'react'
import { Card, Typography } from '@heroui/react'
import { useWikiStore } from '../../state/wikiStore'
import { useShellStore } from '../../state/shellStore'
import type { WikiBlock, WikiDocument, WikiSourceBinding, DraftBlockChange } from '../../../lib/contracts/wiki'
import type { HeadingContent, ProseContent, SignatureContent, CalloutContent, TableContent, DiagramContent, ListContent } from '../../../lib/contracts/wiki'
import { HeadingBlock as HeadingBlockV2, ProseBlock, SignatureBlock, CalloutBlock, TableBlock as TableBlockV2, DiagramBlock as DiagramBlockV2, ListBlock as ListBlockV2 } from './blocks'
import './wiki-theme.css'
import WikiBlockIssueInline from './WikiBlockIssueInline'

// ── Stale badge ──────────────────────────────────────────────────────────────

function StaleBadge({ state }: { state: WikiBlock['staleState'] }) {
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

// ── Manual state badge ───────────────────────────────────────────────────────

function ManualBadge({ state }: { state: WikiBlock['manualState'] }) {
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

// ── Block content dispatch ───────────────────────────────────────────────────

function isV2Content(block: WikiBlock): boolean {
  const c = block.content as Record<string, unknown>
  if (block.blockType === 'prose' && Array.isArray(c?.segments)) return true
  if (block.blockType === 'signature' && Array.isArray(c?.tokens)) return true
  if (block.blockType === 'callout' && c?.level && Array.isArray(c?.body)) return true
  if (block.blockType === 'table' && Array.isArray(c?.headers) && Array.isArray(c?.rows)) return true
  if (block.blockType === 'diagram' && c?.diagramType && c?.code) return true
  if (block.blockType === 'list' && Array.isArray(c?.items)) return true
  return false
}

function BlockContent({ block }: { block: WikiBlock }) {
  const content = block.content as Record<string, unknown>

  // v2 structured JSON blocks
  if (block.contentFormat === 'structured_json' || isV2Content(block)) {
    switch (block.blockType) {
      case 'heading':
        return <HeadingBlockV2 content={content as unknown as HeadingContent} />
      case 'prose':
        return <ProseBlock content={content as unknown as ProseContent} />
      case 'signature':
        return <SignatureBlock content={content as unknown as SignatureContent} />
      case 'callout':
        return <CalloutBlock content={content as unknown as CalloutContent} />
      case 'table':
        return <TableBlockV2 content={content as unknown as TableContent} />
      case 'diagram':
        return <DiagramBlockV2 content={content as unknown as DiagramContent} />
      case 'list':
        return <ListBlockV2 content={content as unknown as ListContent} />
    }
  }

  // Legacy fallback: wrap old content formats gracefully
  if (block.blockType === 'heading') {
    const c = content as { level?: number; text?: string }
    return <HeadingBlockV2 content={{ level: (c.level ?? 2) as 1 | 2 | 3, text: c.text ?? '' }} />
  }
  if (block.blockType === 'prose') {
    const c = content as { text?: string }
    return <ProseBlock content={{ segments: [{ type: 'text', value: c.text ?? '' }] }} />
  }
  if (typeof block.content === 'string') {
    return <ProseBlock content={{ segments: [{ type: 'text', value: block.content }] }} />
  }

  // Unknown block type fallback
  return (
    <p className="text-[13px] text-[var(--wiki-text-muted)] italic">
      [Unknown block type: {block.blockType}]
    </p>
  )
}

// ── Inline source file links ────────────────────────────────────────────────

function InlineSourceLinks({ block }: { block: WikiBlock }) {
  const bindingsById = useWikiStore(s => s.bindingsById)
  const projects = useShellStore(s => s.projects)
  const editor = useShellStore(s => s.preferences.editor)
  const project = projects.find(p => p.id === block.projectId)
  const workDir = project?.source?.localPath ?? ''

  const bindings = Object.values(bindingsById)
    .filter((b): b is WikiSourceBinding => b.wikiBlockId === block.id && Boolean(b.filePath))

  const seen = new Map<string, WikiSourceBinding>()
  for (const b of bindings) {
    const existing = seen.get(b.filePath!)
    if (!existing || (b.startLine && !existing.startLine)) {
      seen.set(b.filePath!, b)
    }
  }
  const uniqueBindings = [...seen.values()]

  if (uniqueBindings.length === 0) return null

  function buildUri(filePath: string, line?: number | null): string | null {
    const absPath = workDir ? `${workDir}/${filePath}` : filePath
    switch (editor) {
      case 'vscode': return line ? `vscode://file/${absPath}:${line}` : `vscode://file/${absPath}`
      case 'cursor': return line ? `cursor://file/${absPath}:${line}` : `cursor://file/${absPath}`
      case 'windsurf': return line ? `windsurf://file/${absPath}:${line}` : `windsurf://file/${absPath}`
      case 'webstorm': return line ? `jetbrains://webstorm/open?file=${absPath}&line=${line}` : `jetbrains://webstorm/open?file=${absPath}`
      default: return null
    }
  }

  async function handleSystemOpen(filePath: string, line?: number | null) {
    const absPath = workDir ? `${workDir}/${filePath}` : filePath
    await fetch('/api/config/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: absPath, line: line ?? undefined }),
    })
  }

  return (
    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/10 pt-2">
      {uniqueBindings.map(b => {
        const uri = buildUri(b.filePath!, b.startLine)
        const label = b.startLine ? `${b.filePath}:${b.startLine}` : b.filePath!
        const short = label.split('/').slice(-2).join('/')
        if (uri) {
          return (
            <a
              key={b.id}
              href={uri}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/60 hover:bg-secondary hover:text-foreground transition-colors"
              title={label}
              onClick={e => e.stopPropagation()}
            >
              <FileText size={9} />
              {short}
            </a>
          )
        }
        return (
          <button
            key={b.id}
            type="button"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/60 hover:bg-secondary hover:text-foreground transition-colors"
            title={label}
            onClick={e => { e.stopPropagation(); handleSystemOpen(b.filePath!, b.startLine) }}
          >
            <FileText size={9} />
            {short}
          </button>
        )
      })}
    </div>
  )
}

// ── Block item wrapper ────────────────────────────────────────────────────────

const WikiBlockItem = memo(function WikiBlockItem({ block, issueCount, projectId, draftChange }: { block: WikiBlock; issueCount: number; projectId: string; draftChange?: DraftBlockChange | null }) {
  const bindingsById = useWikiStore(s => s.bindingsById)
  const isSelected = useWikiStore(s => s.selectedBlockId === block.id)
  const selectBlock = useWikiStore(s => s.selectBlock)
  const hasBindings = block.sourceBindingIds.length > 0
    || Object.values(bindingsById).some(b => b.wikiBlockId === block.id)

  const isDelete = draftChange?.action === 'delete'
  const isUpdate = draftChange?.action === 'update'

  return (
    <div
      className={`group relative cursor-pointer rounded-lg p-4 transition-all ${
        isSelected
          ? 'bg-primary/5 ring-1 ring-primary/20'
          : 'hover:bg-card/60'
      }`}
      id={`wiki-block-${block.id}`}
      onClick={() => selectBlock(block.id)}
    >
      {/* Issue indicator */}
      {issueCount > 0 && !isSelected && (
        <span className="absolute right-3 top-3 flex items-center gap-0.5 text-muted-foreground/50">
          <MessageCircle size={11} />
          <span className="text-[9px] font-bold text-amber-400">{issueCount}</span>
        </span>
      )}

      {/* Selected indicator bar */}
      {isSelected && !draftChange && (
        <div className="absolute left-0 top-3 bottom-3 w-0.5 rounded-full bg-primary" />
      )}

      {/* Status badges */}
      {(block.staleState !== 'fresh' || block.manualState !== 'none') && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <StaleBadge state={block.staleState} />
          <ManualBadge state={block.manualState} />
        </div>
      )}

      {/* Content — with inline diff in preview mode */}
      {isUpdate ? (
        <div className="space-y-2">
          <div className="line-through opacity-40 text-muted-foreground">
            <BlockContent block={block} />
          </div>
          {draftChange.newContent ? (
            <div className="border-l-2 border-emerald-500 pl-3 bg-emerald-500/5 rounded-r-md py-1">
              <BlockContent block={{ ...block, content: draftChange.newContent }} />
            </div>
          ) : null}
        </div>
      ) : isDelete ? (
        <div className="line-through opacity-40 text-muted-foreground">
          <BlockContent block={block} />
        </div>
      ) : (
        <BlockContent block={block} />
      )}

      {/* Inline source file links */}
      {hasBindings && !draftChange && (
        <InlineSourceLinks block={block} />
      )}

      {/* Inline issue section */}
      {isSelected && !draftChange && (
        <WikiBlockIssueInline blockId={block.id} projectId={projectId} />
      )}
    </div>
  )
})

// ── Draft preview: inserted block ───────────────────────────────────────────

function DraftInsertedBlock({ content }: { content: unknown }) {
  const c = content as Record<string, unknown>
  if (Array.isArray(c?.segments)) {
    return (
      <div className="mt-2 rounded-lg border-l-2 border-emerald-500 bg-emerald-500/5 p-4">
        <ProseBlock content={c as unknown as ProseContent} />
      </div>
    )
  }
  // Legacy fallback
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return (
    <div className="mt-2 rounded-lg border-l-2 border-emerald-500 bg-emerald-500/5 p-4">
      <ProseBlock content={{ segments: [{ type: 'text', value: text }] }} />
    </div>
  )
}

// ── Page title (first heading block) ────────────────────────────────────────

function PageTitle({ block }: { block: WikiBlock }) {
  let text = ''
  if (block.contentFormat === 'markdown_fragment' && typeof block.content === 'string') {
    text = block.content.replace(/^#{1,6}\s*/, '').trim()
  } else {
    const c = block.content as { text?: string; level?: number }
    text = c.text ?? ''
  }
  return (
    <div className="pt-6 pb-4 mb-3 border-b border-border/20">
      <Typography.Heading level={1}>{text}</Typography.Heading>
    </div>
  )
}

// ── Main renderer ────────────────────────────────────────────────────────────

export default function WikiBlockRenderer({ document, issuesByBlockId, projectId }: { document: WikiDocument; issuesByBlockId?: Map<string, number>; projectId: string }) {
  const blocksById = useWikiStore(s => s.blocksById)
  const snapshot = useWikiStore(s => s.snapshot)
  const selectedBlockId = useWikiStore(s => s.selectedBlockId)
  const selectBlock = useWikiStore(s => s.selectBlock)
  const draftPreviewActive = useWikiStore(s => s.draftPreviewActive)
  const draftPreviewId = useWikiStore(s => s.draftPreviewId)
  const draftsById = useWikiStore(s => s.draftsById)

  const blocks = document.blockIds
    .map(id => blocksById[id])
    .filter((b): b is WikiBlock => Boolean(b))

  const previewDraft = draftPreviewActive && draftPreviewId ? draftsById[draftPreviewId] : null
  const changesMap = useMemo(() => {
    if (!previewDraft || previewDraft.documentId !== document.id) return null
    const map = new Map<string, DraftBlockChange>()
    for (const c of previewDraft.changes) map.set(c.blockId, c)
    return map
  }, [previewDraft, document.id])

  const contentBlocks = useMemo(() => {
    const firstBlock = blocks[0]
    const isFirstHeading = firstBlock?.blockType === 'heading'
    return isFirstHeading ? blocks.slice(1) : blocks
  }, [blocks])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter') return
      e.preventDefault()

      if (e.key === 'Enter' && selectedBlockId) {
        const blockEl = window.document.getElementById(`wiki-block-${selectedBlockId}`)
        const textarea = blockEl?.querySelector('textarea')
        textarea?.focus()
        return
      }

      const currentIdx = contentBlocks.findIndex(b => b.id === selectedBlockId)
      let nextIdx: number
      if (e.key === 'ArrowDown') {
        nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, contentBlocks.length - 1)
      } else {
        nextIdx = currentIdx <= 0 ? 0 : currentIdx - 1
      }
      const nextBlock = contentBlocks[nextIdx]
      if (nextBlock) {
        selectBlock(nextBlock.id)
        const el = window.document.getElementById(`wiki-block-${nextBlock.id}`)
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [contentBlocks, selectedBlockId, selectBlock])

  if (blocks.length === 0) {
    const isGenerating = snapshot?.status === 'outline_ready' || snapshot?.status === 'writing'
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        {isGenerating ? (
          <>
            <Loader2 size={20} className="animate-spin text-muted-foreground/30" />
            <p className="text-[12px] text-muted-foreground/50">内容生成中，请稍候…</p>
          </>
        ) : (
          <>
            <FileText size={24} className="text-muted-foreground/20" />
            <p className="text-[12px] text-muted-foreground/40">此文档暂无内容</p>
          </>
        )}
      </div>
    )
  }

  const firstBlock = blocks[0]
  const isFirstHeading = firstBlock?.blockType === 'heading'

  return (
    <div className="wiki-doc space-y-3">
      {isFirstHeading && <PageTitle block={firstBlock} />}
      {contentBlocks.map(block => {
        const change = changesMap?.get(block.id) ?? null
        return (
          <div key={block.id}>
            <WikiBlockItem block={block} issueCount={issuesByBlockId?.get(block.id) ?? 0} projectId={projectId} draftChange={change} />
            {change?.action === 'insert_after' && change.newContent ? (
              <DraftInsertedBlock content={change.newContent} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
