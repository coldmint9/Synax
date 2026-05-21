// ---------------------------------------------------------------------------
// web/.../context/MemoryBrowser.tsx
//
// 项目级长期记忆浏览与管理：
//   - 列表 + 按 memoryType 过滤
//   - 搜索（走 contextApi.search scope=memories）
//   - Pin（注入系统提示）/ Archive / Delete
//   - 从当前会话提取（POST /api/context/memories/extract）
// ---------------------------------------------------------------------------

import { Archive, BookOpen, Pin, PinOff, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { MemoryType, ProjectMemory } from '../../../../lib/api/context'
import { useContextStore } from '../../../state/contextStore'

const TYPE_COLORS: Record<MemoryType, string> = {
  pattern: 'bg-sky-500/15 text-sky-400',
  decision: 'bg-violet-500/15 text-violet-400',
  preference: 'bg-pink-500/15 text-pink-400',
  convention: 'bg-emerald-500/15 text-emerald-400',
  insight: 'bg-amber-500/15 text-amber-400',
  risk: 'bg-rose-500/15 text-rose-400',
}

const ALL_TYPES: ('all' | MemoryType)[] = [
  'all',
  'pattern',
  'decision',
  'preference',
  'convention',
  'insight',
  'risk',
]

export default function MemoryBrowser() {
  const projectId = useContextStore((s) => s.projectId)
  const currentSessionId = useContextStore((s) => s.currentSessionId)
  const memories = useContextStore((s) => s.memories)
  const pinnedIds = useContextStore((s) => s.pinnedMemoryIds)
  const loading = useContextStore((s) => s.loading.memories)
  const refresh = useContextStore((s) => s.refreshMemories)
  const updateMemory = useContextStore((s) => s.updateMemory)
  const deleteMemory = useContextStore((s) => s.deleteMemory)
  const togglePin = useContextStore((s) => s.togglePinnedMemory)

  const [filter, setFilter] = useState<'all' | MemoryType>('all')
  const [query, setQuery] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const typeOk = (m: ProjectMemory) => filter === 'all' || m.memoryType === filter
    const q = query.trim().toLowerCase()
    const qOk = (m: ProjectMemory) =>
      !q ||
      m.title.toLowerCase().includes(q) ||
      m.content.toLowerCase().includes(q) ||
      m.tags.some((t) => t.toLowerCase().includes(q))
    return memories.filter((m) => typeOk(m) && qOk(m))
  }, [memories, filter, query])

  const handleExtract = async () => {
    if (!currentSessionId) {
      setExtractError('请先选中一个会话')
      return
    }
    setExtracting(true)
    setExtractError(null)
    try {
      // 使用全局 fetch，避免在 store 上挂新 action
      await fetch('/api/context/memories/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId }),
      })
      await refresh()
    } catch (err) {
      setExtractError((err as Error).message)
    } finally {
      setExtracting(false)
    }
  }

  if (!projectId) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
        未绑定项目
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="border-b border-border/40 px-2 py-1.5">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Memories ({memories.length})
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label="Refresh"
              disabled={loading}
            >
              <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={() => void handleExtract()}
              className="flex items-center gap-1 rounded border border-border/40 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
              disabled={extracting || !currentSessionId}
              title="从当前会话提取长期记忆"
            >
              <Sparkles size={10} />
              extract
            </button>
          </div>
        </div>
        <div className="mb-1 flex items-center gap-1 rounded border border-border/40 bg-background/60 px-1.5">
          <Search size={10} className="text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter..."
            className="h-5 flex-1 bg-transparent text-[11px] placeholder:text-muted-foreground/60 focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {ALL_TYPES.map((t) => {
            const active = filter === t
            return (
              <button
                key={t}
                type="button"
                onClick={() => setFilter(t)}
                className={`rounded px-1.5 py-0.5 text-[9px] transition ${
                  active
                    ? 'bg-primary/20 text-primary'
                    : 'bg-secondary/40 text-muted-foreground hover:bg-secondary'
                }`}
              >
                {t}
              </button>
            )
          })}
        </div>
        {extractError && (
          <div className="mt-1 text-[10px] text-destructive">{extractError}</div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-[11px] text-muted-foreground">
            <BookOpen size={20} className="opacity-40" />
            暂无记忆
          </div>
        ) : (
          <ul className="divide-y divide-border/30">
            {filtered.map((m) => {
              const pinned = pinnedIds.includes(m.id)
              return (
                <li key={m.id} className="group px-2 py-1.5 hover:bg-secondary/20">
                  <div className="flex items-start gap-1.5">
                    <span
                      className={`shrink-0 rounded px-1 py-px font-mono text-[9px] ${TYPE_COLORS[m.memoryType]}`}
                    >
                      {m.memoryType}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium" title={m.title}>
                          {m.title}
                        </span>
                        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                          {(m.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 break-words text-[10px] text-muted-foreground">
                        {m.content}
                      </div>
                      {m.tags.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap gap-0.5">
                          {m.tags.slice(0, 5).map((t) => (
                            <span
                              key={t}
                              className="rounded bg-secondary/50 px-1 py-px font-mono text-[9px] text-muted-foreground"
                            >
                              #{t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => togglePin(m.id)}
                        className={`rounded p-0.5 ${
                          pinned
                            ? 'bg-primary/15 text-primary'
                            : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                        }`}
                        title={pinned ? 'unpin' : 'pin into active analyzer context'}
                      >
                        {pinned ? <PinOff size={10} /> : <Pin size={10} />}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void updateMemory(m.id, { status: 'archived' })
                        }
                        className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                        title="archive"
                      >
                        <Archive size={10} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(`删除记忆 "${m.title}"？`)) {
                            void deleteMemory(m.id)
                          }
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title="delete"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
