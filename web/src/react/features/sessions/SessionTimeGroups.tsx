import { useCallback, useState } from 'react'
import { useLocale } from '../../../hooks/useLocale'
import { SessionTreeItem } from './SessionTreeItem'
import type { TimeGroup } from './useSessionList'

interface Props {
  groups: TimeGroup[]
  selectedId: string | null
  isLoading?: boolean
  error?: string | null
  onRetry?: () => void
  isLoadingMore: boolean
  hasMore: boolean
  hideGroupHeaders?: boolean
  emptyLabel?: string
  onSelect: (id: string) => void
  onToggleGroup: (key: string) => void
  onToggleExpand: (id: string) => void
  onLoadMore: () => void
  onDelete: (id: string) => void
}

export function SessionTimeGroups({
  groups,
  selectedId,
  isLoadingMore,
  hasMore,
  isLoading = false,
  error,
  onRetry,
  hideGroupHeaders = false,
  emptyLabel,
  onSelect,
  onToggleGroup,
  onToggleExpand,
  onLoadMore,
  onDelete,
}: Props) {
  const { locale } = useLocale()
  // ponytail: retain mounted rows in batches of 30; window only if profiling shows long-scroll DOM growth matters.
  const [visibleCount, setVisibleCount] = useState(30)
  const totalRows = groups.reduce((sum, group) => sum + group.sessions.length, 0)
  const revealMore = useCallback(() => {
    if (visibleCount < totalRows) setVisibleCount((count) => count + 30)
    else if (hasMore && !isLoadingMore) onLoadMore()
  }, [visibleCount, totalRows, hasMore, isLoadingMore, onLoadMore])
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 120 && !isLoadingMore) {
        revealMore()
      }
    },
    [isLoadingMore, revealMore],
  )

  // Filter out empty groups
  const nonEmptyGroups = groups.filter((g) => g.count > 0)

  if (isLoading && nonEmptyGroups.length === 0)
    return (
      <div
        role="status"
        className="session-list-skeleton space-y-2 p-3"
        aria-label={locale === 'zh' ? '正在加载会话' : 'Loading sessions'}
      >
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-16 rounded-lg bg-secondary/50 animate-pulse" />
        ))}
      </div>
    )
  if (nonEmptyGroups.length === 0 && !hasMore && !error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-[28px] opacity-30">☕</span>
        <span className="text-[11px]">{emptyLabel ?? 'No sessions yet'}</span>
      </div>
    )
  }

  const totalItems = nonEmptyGroups.reduce((sum, g) => sum + g.sessions.length, 0)

  let remaining = visibleCount
  return (
    <div className="session-list-groups flex-1 overflow-y-auto pl-2 pr-0.5 py-1" onScroll={onScroll}>
      {nonEmptyGroups.map((g) => {
        const rows = g.sessions.slice(0, Math.max(0, remaining))
        remaining -= rows.length
        return (
          <div key={g.key}>
            {!hideGroupHeaders ? (
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
            ) : null}
            {!g.collapsed &&
              rows.map((n) => (
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
        )
      })}
      {isLoadingMore && (
        <div className="py-3 text-center text-[10px] text-muted-foreground animate-pulse">Loading more…</div>
      )}
      {error ? (
        <div role="alert" className="p-3 text-center text-xs text-muted-foreground">
          <p>
            {locale === 'zh' ? '加载失败，已保留现有会话' : 'Loading failed. Existing sessions were kept.'}
          </p>
          <button type="button" onClick={onRetry} className="mt-2 underline">
            {locale === 'zh' ? '重试' : 'Retry'}
          </button>
        </div>
      ) : null}
      {(hasMore || visibleCount < totalRows) && (
        <button
          type="button"
          disabled={isLoadingMore}
          onClick={revealMore}
          className="w-full py-3 text-xs text-muted-foreground"
        >
          {locale === 'zh' ? '加载更多' : 'Load more'}
        </button>
      )}
      {!hasMore && visibleCount >= totalRows && totalItems > 0 && (
        <div className="py-2.5 text-center text-[9px] text-muted-foreground/40">All loaded</div>
      )}
    </div>
  )
}
