// ---------------------------------------------------------------------------
// web/.../context/ContextTimeline.tsx
//
// 当前会话的时间线：按 sequence 升序展示 entries，可展开查看内容；
// 上部展示最近的 snapshots（点击仅显示摘要，恢复功能 Phase 3+ 接入）。
// ---------------------------------------------------------------------------

import { Camera, ChevronDown, ChevronRight, Bot, User, Wrench, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useContextStore } from '../../../state/contextStore'
import type { ContextEntry } from '../../../../lib/api/context'

function roleIcon(role: ContextEntry['role']) {
  if (role === 'user') return <User size={10} />
  if (role === 'assistant') return <Bot size={10} />
  if (role === 'tool') return <Wrench size={10} />
  return <Zap size={10} />
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

export default function ContextTimeline() {
  const currentSessionId = useContextStore((s) => s.currentSessionId)
  const entries = useContextStore((s) => s.entries)
  const snapshots = useContextStore((s) => s.snapshots)
  const recordSnapshot = useContextStore((s) => s.recordSnapshot)
  const loadingEntries = useContextStore((s) => s.loading.entries)

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))

  // 按 sequence 升序
  const ordered = useMemo(
    () => [...entries].sort((a, b) => a.sequence - b.sequence),
    [entries],
  )

  if (!currentSessionId) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
        未选中会话
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-xs">
      {/* ── Snapshots ── */}
      <div className="border-b border-border/40">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Snapshots ({snapshots.length})
          </span>
          <button
            type="button"
            onClick={() => void recordSnapshot()}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            title="创建当前进度快照"
          >
            <Camera size={10} />
            capture
          </button>
        </div>
        {snapshots.length > 0 && (
          <div className="max-h-24 overflow-y-auto px-2 pb-1.5">
            {snapshots.slice(0, 10).map((s) => (
              <div
                key={s.id}
                className="mb-0.5 flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-secondary/40"
                title={s.compressedContent ?? ''}
              >
                <Camera size={9} className="shrink-0 text-primary/60" />
                <span className="truncate text-[10px]">
                  {s.label ?? `seq ${s.fromSequence}-${s.toSequence}`}
                </span>
                <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                  {fmtTime(s.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Entries ── */}
      <div className="flex-1 overflow-y-auto">
        {loadingEntries && ordered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            加载中…
          </div>
        ) : ordered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            尚无条目
          </div>
        ) : (
          <ul>
            {ordered.map((e) => {
              const open = expanded[e.id]
              const preview = e.content.slice(0, 120)
              const hasMore = e.content.length > preview.length
              return (
                <li
                  key={e.id}
                  className="border-b border-border/20 px-2 py-1 hover:bg-secondary/20"
                >
                  <button
                    type="button"
                    onClick={() => toggle(e.id)}
                    className="flex w-full items-center gap-1.5 text-left"
                  >
                    {hasMore ? (
                      open ? <ChevronDown size={10} /> : <ChevronRight size={10} />
                    ) : (
                      <span className="w-[10px]" />
                    )}
                    <span
                      className={`inline-flex items-center gap-1 rounded px-1 py-px font-mono text-[9px] ${
                        e.role === 'user'
                          ? 'bg-blue-500/15 text-blue-400'
                          : e.role === 'assistant'
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : e.role === 'tool'
                          ? 'bg-orange-500/15 text-orange-400'
                          : 'bg-secondary text-muted-foreground'
                      }`}
                    >
                      {roleIcon(e.role)}
                      {e.role}
                    </span>
                    <span className="font-mono text-[9px] text-muted-foreground">
                      #{e.sequence}
                    </span>
                    <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                      {fmtTime(e.createdAt)}
                    </span>
                  </button>
                  <div
                    className={`ml-4 mt-0.5 whitespace-pre-wrap break-words text-[11px] text-foreground/90 ${
                      open ? '' : 'line-clamp-2'
                    }`}
                  >
                    {open ? e.content : preview + (hasMore ? '…' : '')}
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
