import { AlertTriangle, Code2, FileText, Lock, Loader2, Pencil, Maximize2, X } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { Streamdown } from 'streamdown'
import { streamdownPlugins } from '../../../lib/streamdown-plugins'
import { useWikiStore } from '../../state/wikiStore'
import { useShellStore } from '../../state/shellStore'
import WikiBlockEditor from './WikiBlockEditor'
import type { WikiBlock, WikiDocument, WikiSourceBinding } from '../../../lib/contracts/wiki'
import './wiki-prose.css'

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

// ── Block content renderers ──────────────────────────────────────────────────

function HeadingBlock({ content }: { content: unknown }) {
  const c = content as { level?: number; text?: string }
  const level = c.level ?? 2
  const text = c.text ?? ''
  if (level === 1) return <h1 className="text-xl font-bold text-foreground">{text}</h1>
  if (level === 2) return <h2 className="text-base font-semibold text-foreground">{text}</h2>
  return <h3 className="text-sm font-semibold text-foreground/90">{text}</h3>
}

function ParagraphBlock({ content }: { content: unknown }) {
  const c = content as { text?: string }
  return <p className="text-[13px] leading-relaxed text-foreground/85">{c.text ?? ''}</p>
}

function ListBlock({ content }: { content: unknown }) {
  const c = content as { items?: string[]; ordered?: boolean }
  const items = c.items ?? []
  if (c.ordered) {
    return (
      <ol className="list-decimal space-y-1 pl-5 text-[13px] text-foreground/85">
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ol>
    )
  }
  return (
    <ul className="list-disc space-y-1 pl-5 text-[13px] text-foreground/85">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  )
}

function TableBlock({ content }: { content: unknown }) {
  const c = content as { headers?: string[]; rows?: string[][] }
  const headers = c.headers ?? []
  const rows = c.rows ?? []
  return (
    <div className="overflow-x-auto rounded-lg border border-border/40">
      <table className="w-full text-[12px]">
        <thead className="bg-secondary/40">
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left font-medium text-foreground/80">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-border/30 hover:bg-secondary/20">
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-2 text-foreground/75">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CodeRefBlock({ content }: { content: unknown }) {
  const c = content as { language?: string; code?: string; filePath?: string }
  return (
    <div className="rounded-lg border border-border/40 bg-card/60">
      {c.filePath && (
        <div className="flex items-center gap-1.5 border-b border-border/30 px-3 py-1.5">
          <Code2 size={11} className="text-muted-foreground/60" />
          <span className="font-mono text-[11px] text-muted-foreground/80">{c.filePath}</span>
        </div>
      )}
      <pre className="overflow-x-auto p-3 text-[12px] leading-relaxed text-foreground/85">
        <code>{c.code ?? ''}</code>
      </pre>
    </div>
  )
}

function DecisionBlock({ content }: { content: unknown }) {
  const c = content as { title?: string; decision?: string; rationale?: string; alternatives?: string[] }
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
      <div className="text-[12px] font-semibold text-primary">{c.title ?? 'Decision'}</div>
      {c.decision && <p className="text-[13px] text-foreground/85">{c.decision}</p>}
      {c.rationale && (
        <p className="text-[12px] text-muted-foreground italic">{c.rationale}</p>
      )}
      {c.alternatives && c.alternatives.length > 0 && (
        <div>
          <div className="text-[11px] font-medium text-muted-foreground mb-1">Alternatives</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {c.alternatives.map((a, i) => (
              <li key={i} className="text-[12px] text-foreground/70">{a}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function RiskBlock({ content }: { content: unknown }) {
  const c = content as { title?: string; description?: string; severity?: string; mitigation?: string }
  const severityColor = c.severity === 'high'
    ? 'border-destructive/30 bg-destructive/5'
    : c.severity === 'medium'
    ? 'border-warning/30 bg-warning/5'
    : 'border-border/40 bg-card/60'
  return (
    <div className={`rounded-lg border p-3 space-y-1.5 ${severityColor}`}>
      <div className="flex items-center gap-2">
        <AlertTriangle size={12} className="text-warning shrink-0" />
        <span className="text-[12px] font-semibold text-foreground/90">{c.title ?? 'Risk'}</span>
        {c.severity && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.severity}</span>
        )}
      </div>
      {c.description && <p className="text-[13px] text-foreground/80">{c.description}</p>}
      {c.mitigation && (
        <p className="text-[12px] text-muted-foreground">Mitigation: {c.mitigation}</p>
      )}
    </div>
  )
}

function MarkdownFragmentBlock({ content }: { content: unknown }) {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return (
    <div className="wiki-prose">
      <Streamdown
        className="feed-prose text-[13px] leading-relaxed text-foreground/85"
        mode="static"
        parseIncompleteMarkdown
        plugins={streamdownPlugins}
        controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
        lineNumbers
      >
        {text}
      </Streamdown>
    </div>
  )
}

function DiagramBlock({ content }: { content: unknown }) {
  const raw = typeof content === 'string' ? content : JSON.stringify(content)
  const headingMatch = raw.match(/^(#{1,3})\s+(.+)\n/)
  const heading = headingMatch?.[2]
  const fenceMatch = raw.match(/```mermaid\n([\s\S]*?)```/)
  const code = fenceMatch ? fenceMatch[1].trim() : raw.replace(/^#{1,3}\s+.+\n+/, '').trim()
  const [svgHtml, setSvgHtml] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!code) return
    let cancelled = false
    const id = `mmd-${Math.random().toString(36).slice(2, 9)}`
    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark' })
      try {
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) setSvgHtml(svg)
      } catch (e: any) {
        if (!cancelled) setError(e?.message || String(e))
      }
    })
    return () => { cancelled = true }
  }, [code])

  if (error) {
    return (
      <div className="space-y-2">
        {heading && <h3 className="text-sm font-semibold text-foreground/90">{heading}</h3>}
        <pre className="overflow-x-auto rounded-md bg-black/30 p-3 text-[11px] leading-relaxed text-foreground/60 whitespace-pre-wrap">{code}</pre>
      </div>
    )
  }

  if (!svgHtml) {
    return (
      <div className="space-y-2">
        {heading && <h3 className="text-sm font-semibold text-foreground/90">{heading}</h3>}
        <div className="flex h-24 items-center justify-center text-[12px] text-muted-foreground/50">加载图表...</div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {heading && <h3 className="text-sm font-semibold text-foreground/90">{heading}</h3>}
      <div className="relative group/diagram">
        <div
          className="w-full overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
        <button
          type="button"
          onClick={() => setFullscreen(true)}
          className="absolute top-1 right-1 rounded p-1 text-muted-foreground/40 opacity-0 transition-opacity group-hover/diagram:opacity-100 hover:bg-secondary/80 hover:text-foreground"
        >
          <Maximize2 size={12} />
        </button>
      </div>
      {fullscreen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm" onClick={() => setFullscreen(false)}>
          <button type="button" onClick={() => setFullscreen(false)} className="absolute top-4 right-4 z-10 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X size={20} />
          </button>
          <div className="h-[90vh] w-[90vw] overflow-auto p-6" dangerouslySetInnerHTML={{ __html: svgHtml }} onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}

function BlockContent({ block }: { block: WikiBlock }) {
  if (block.contentFormat === 'markdown_fragment' && typeof block.content === 'string') {
    return <MarkdownFragmentBlock content={block.content} />
  }
  switch (block.blockType) {
    case 'heading': return <HeadingBlock content={block.content} />
    case 'paragraph': return <ParagraphBlock content={block.content} />
    case 'list': return <ListBlock content={block.content} />
    case 'table': return <TableBlock content={block.content} />
    case 'diagram': return <DiagramBlock content={block.content} />
    case 'code_ref': return <CodeRefBlock content={block.content} />
    case 'decision': return <DecisionBlock content={block.content} />
    case 'risk': return <RiskBlock content={block.content} />
    default: return <MarkdownFragmentBlock content={block.content} />
  }
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
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      <FileText size={10} className="text-muted-foreground/50 shrink-0" />
      {uniqueBindings.map(b => {
        const displayName = b.filePath!.split('/').slice(-2).join('/')
        const uri = buildUri(b.filePath!, b.startLine)

        if (uri) {
          return (
            <a
              key={b.id}
              href={uri}
              className="font-mono text-[11px] text-primary/70 hover:text-primary hover:underline"
              title={b.filePath!}
            >
              {displayName}
            </a>
          )
        }

        return (
          <button
            key={b.id}
            type="button"
            onClick={() => handleSystemOpen(b.filePath!, b.startLine)}
            className="font-mono text-[11px] text-primary/70 hover:text-primary hover:underline"
            title={b.filePath!}
          >
            {displayName}
          </button>
        )
      })}
    </div>
  )
}

// ── Block wrapper ────────────────────────────────────────────────────────────

function WikiBlockItem({ block }: { block: WikiBlock }) {
  const bindingsById = useWikiStore(s => s.bindingsById)
  const hasBindings = block.sourceBindingIds.length > 0
    || Object.values(bindingsById).some(b => b.wikiBlockId === block.id)
  const [editing, setEditing] = useState(false)

  return (
    <div className="group relative rounded-xl border border-border/30 bg-card/40 p-4 transition-colors hover:border-border/60 hover:bg-card/60" id={`wiki-block-${block.id}`}>
      {/* Status badges */}
      {(block.staleState !== 'fresh' || block.manualState !== 'none') && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <StaleBadge state={block.staleState} />
          <ManualBadge state={block.manualState} />
        </div>
      )}

      {/* Edit button (hover) */}
      {!editing && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="absolute right-2 top-2 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground/50 hover:bg-secondary hover:text-foreground"
          title="编辑此 block"
        >
          <Pencil size={11} />
        </button>
      )}

      {/* Content or Editor */}
      {editing ? (
        <WikiBlockEditor block={block} onClose={() => setEditing(false)} />
      ) : (
        <BlockContent block={block} />
      )}

      {/* Inline source file links */}
      {hasBindings && !editing && (
        <InlineSourceLinks block={block} />
      )}
    </div>
  )
}

// ── Main renderer ────────────────────────────────────────────────────────────

export default function WikiBlockRenderer({ document }: { document: WikiDocument }) {
  const blocksById = useWikiStore(s => s.blocksById)
  const snapshot = useWikiStore(s => s.snapshot)
  const blocks = document.blockIds
    .map(id => blocksById[id])
    .filter((b): b is WikiBlock => Boolean(b))

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

  return (
    <div className="space-y-3">
      {blocks.map(block => (
        <WikiBlockItem key={block.id} block={block} />
      ))}
    </div>
  )
}
