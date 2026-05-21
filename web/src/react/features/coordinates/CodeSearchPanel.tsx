import { useCallback, useState } from 'react'
import { Search, Loader2, X, Compass } from 'lucide-react'
import { useCoordinatesState } from '../../state/coordinatesStore'
import type { SearchHit, SearchMode, MountHint } from '../../../lib/api/analyzer'
import SourceLinkBadge, { type Provenance } from './SourceLinkBadge'

// -----------------------------------------------------------------------------
// CodeSearchPanel - 浮动在 canvas 顶部的代码检索面板
//   - 调用 state.search(query, mode, topK) → SearchHit[]
//   - 单击结果 → setSelectedNode(symbolIds[0])
//   - 支持切换 mode (keyword / hybrid)，topK 默认 20
//   - 可折叠（图标状态）+ 展开（搜索态）
//   - 辅助操作：根据当前 query 做 suggestMount
// -----------------------------------------------------------------------------

interface Props {
  projectId: string
  projectName: string
}

type Tab = 'search' | 'mount'

export default function CodeSearchPanel({ projectId, projectName }: Props) {
  const search = useCoordinatesState(projectId, projectName, (s) => s.search)
  const suggestMount = useCoordinatesState(projectId, projectName, (s) => s.suggestMount)
  const setSelectedNode = useCoordinatesState(projectId, projectName, (s) => s.setSelectedNode)

  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('search')
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [hints, setHints] = useState<MountHint[]>([])
  const [error, setError] = useState<string | null>(null)

  const runSearch = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    try {
      if (tab === 'search') {
        const result = await search(trimmed, mode, 20)
        setHits(result)
      } else {
        const result = await suggestMount(trimmed)
        setHints(result)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [tab, query, mode, search, suggestMount])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') runSearch()
    if (e.key === 'Escape') setOpen(false)
  }

  // ── 折叠态：只显示一个浮动按钮 ─────────────────────────────────────────
  if (!open) {
    return (
      <button
        className="flex items-center gap-1.5 rounded-lg border border-border/40 bg-background/80 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground"
        onClick={() => setOpen(true)}
        aria-label="Open code search"
      >
        <Search size={12} />
        <span>搜索代码</span>
        <kbd className="ml-1 rounded border border-border/50 px-1 py-0 text-[9px] font-mono text-muted-foreground/80">/</kbd>
      </button>
    )
  }

  // ── 展开态 ────────────────────────────────────────────────────────────
  return (
    <div className="w-[440px] max-w-[calc(100vw-2rem)] rounded-lg border border-border/40 bg-background/95 p-3 shadow-xl backdrop-blur-sm">
      {/* header */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-border/40 bg-background/60 p-0.5 text-[10px]">
          <button
            onClick={() => setTab('search')}
            className={`rounded px-2 py-0.5 ${tab === 'search' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            代码检索
          </button>
          <button
            onClick={() => setTab('mount')}
            className={`rounded px-2 py-0.5 ${tab === 'mount' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            挂载建议
          </button>
        </div>
        {tab === 'search' && (
          <div className="flex items-center gap-1 rounded-md border border-border/40 p-0.5 text-[10px]">
            <button
              onClick={() => setMode('hybrid')}
              className={`rounded px-1.5 py-0.5 ${mode === 'hybrid' ? 'bg-purple-500/15 text-purple-300' : 'text-muted-foreground hover:text-foreground'}`}
              title="图 + 关键词融合"
            >
              hybrid
            </button>
            <button
              onClick={() => setMode('keyword')}
              className={`rounded px-1.5 py-0.5 ${mode === 'keyword' ? 'bg-emerald-500/15 text-emerald-300' : 'text-muted-foreground hover:text-foreground'}`}
              title="仅 BM25 关键词"
            >
              keyword
            </button>
          </div>
        )}
        <div className="ml-auto" />
        <button
          className="rounded-full p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          onClick={() => setOpen(false)}
          aria-label="Close search"
        >
          <X size={12} />
        </button>
      </div>

      {/* input */}
      <div className="mt-2 flex items-center gap-2 rounded-md border border-border/50 bg-background/60 px-2 py-1.5">
        {loading ? (
          <Loader2 size={12} className="animate-spin text-primary" />
        ) : tab === 'search' ? (
          <Search size={12} className="text-muted-foreground" />
        ) : (
          <Compass size={12} className="text-muted-foreground" />
        )}
        <input
          autoFocus
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          placeholder={tab === 'search' ? '搜索符号/函数/文件…' : '描述想要挂载的意图…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="rounded border border-border/50 px-2 py-0.5 text-[10px] hover:bg-muted/60"
          onClick={runSearch}
          disabled={loading || !query.trim()}
        >
          执行
        </button>
      </div>

      {/* error */}
      {error && (
        <div className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </div>
      )}

      {/* results */}
      <div className="mt-2 max-h-[360px] overflow-y-auto pr-1">
        {tab === 'search' && hits.length === 0 && !loading && query && !error && (
          <div className="py-3 text-center text-[11px] text-muted-foreground">无匹配结果</div>
        )}
        {tab === 'search' &&
          hits.map((h) => (
            <button
              key={h.id}
              className="group mb-1 block w-full rounded border border-transparent px-2 py-1.5 text-left hover:border-border/50 hover:bg-muted/40"
              onClick={() => {
                const sid = h.symbolIds?.[0]
                if (sid) setSelectedNode(sid)
              }}
            >
              <div className="flex items-center gap-2">
                <SourceLinkBadge
                  filePath={h.filePath}
                  startLine={h.range.startLine}
                  endLine={h.range.endLine}
                  provenance={h.provenance as Provenance | undefined}
                  score={h.score}
                  compact
                />
                <span className="ml-auto text-[9px] uppercase tracking-wide text-muted-foreground">
                  {h.kind}
                </span>
              </div>
              <div className="mt-1 line-clamp-2 font-mono text-[11px] text-foreground/80">
                {h.preview}
              </div>
            </button>
          ))}

        {tab === 'mount' && hints.length === 0 && !loading && query && !error && (
          <div className="py-3 text-center text-[11px] text-muted-foreground">暂无候选挂载点</div>
        )}
        {tab === 'mount' &&
          hints.map((hint, i) => (
            <button
              key={hint.nodeId ?? `${hint.suggestedParentId}-${i}`}
              className="group mb-1 block w-full rounded border border-transparent px-2 py-1.5 text-left hover:border-border/50 hover:bg-muted/40"
              onClick={() => hint.nodeId && setSelectedNode(hint.nodeId)}
            >
              <div className="flex items-center gap-2">
                <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono text-primary">
                  {hint.suggestedType}
                </span>
                <span className="text-xs font-medium">{hint.label}</span>
                <span className="ml-auto text-[9px] text-muted-foreground">score {hint.score.toFixed(2)}</span>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {hint.rationale}
              </div>
              <div className="mt-1 text-[10px] font-mono text-muted-foreground/70">
                parent: {hint.suggestedParentId}
              </div>
            </button>
          ))}
      </div>
    </div>
  )
}
