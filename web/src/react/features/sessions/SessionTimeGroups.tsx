import { useCallback } from 'react'
import { SessionTreeItem } from './SessionTreeItem'
import type { TimeGroup } from './useSessionList'

interface Props {
  groups: TimeGroup[]
  selectedId: string | null
  isLoadingMore: boolean
  hasMore: boolean
  onSelect: (id: string) => void
  onToggleGroup: (key: string) => void
  onToggleExpand: (id: string) => void
  onLoadMore: () => void
  onDelete: (id: string) => void
}

export function SessionTimeGroups({
  groups, selectedId, isLoadingMore, hasMore,
  onSelect, onToggleGroup, onToggleExpand, onLoadMore, onDelete,
}: Props) {
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60 && hasMore && !isLoadingMore) {
      onLoadMore()
    }
  }, [hasMore, isLoadingMore, onLoadMore])

  // Filter out empty groups
  const nonEmptyGroups = groups.filter(g => g.count > 0)

  if (nonEmptyGroups.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-[28px] opacity-30">☕</span>
        <span className="text-[11px]">No sessions yet</span>
        <span className="text-[9px] text-muted-foreground/50">Agent sessions will appear here</span>
      </div>
    )
  }

  const totalItems = nonEmptyGroups.reduce((sum, g) => sum + g.sessions.length, 0)

  return (
    <div className="flex-1 overflow-y-auto px-1 py-1" onScroll={onScroll}>
      {nonEmptyGroups.map(g => (
        <div key={g.key}>
          <button
            className="list-section-label sticky top-0 z-10 w-full cursor-pointer bg-background/95 backdrop-blur-sm"
            onClick={() => onToggleGroup(g.key)}
          >
            <span className="text-[10px] w-3 text-center text-muted-foreground/60">
              {g.collapsed ? '▸' : '▾'}
            </span>
            {g.label}
            <span className="text-muted-foreground/40">· {g.count}</span>
          </button>
          {!g.collapsed && g.sessions.map(n => (
            <SessionTreeItem
              key={n.session.id}
              node={n}
              isSelected={n.session.id === selectedId}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onDelete={onDelete}
            />
          ))}
        </div>
      ))}
      {isLoadingMore && (
        <div className="py-3 text-center text-[10px] text-muted-foreground animate-pulse">
          Loading more…
        </div>
      )}
      {!hasMore && totalItems > 0 && (
        <div className="py-2.5 text-center text-[9px] text-muted-foreground/40">
          All loaded
        </div>
      )}
    </div>
  )
}
