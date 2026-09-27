import { ChevronDown, Pin } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { useLocale } from "../../../hooks/useLocale";
import { SynaxWordmark } from "./SynaxWordmark";
import { SessionTreeItem } from "./SessionTreeItem";
import type { TimeGroup } from "./useSessionList";

interface Props {
  groups: TimeGroup[];
  selectedId: string | null;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  isLoadingMore: boolean;
  hasMore: boolean;
  hideGroupHeaders?: boolean;
  emptyLabel?: string;
  onSelect: (id: string) => void;
  onToggleGroup: (key: string) => void;
  onToggleExpand: (id: string) => void;
  onLoadMore: () => void;
  onDelete: (id: string) => void;
  onTogglePin?: (id: string) => Promise<void>;
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
  onTogglePin,
}: Props) {
  const { locale } = useLocale();
  const groupId = useId();
  // ponytail: retain mounted rows in batches of 30; window only if profiling shows long-scroll DOM growth matters.
  const [visibleCount, setVisibleCount] = useState(30);
  const totalRows = Math.max(
    0,
    ...groups
      .filter((group) => !group.collapsed)
      .map((group) => group.sessions.length),
  );
  const anyExpanded = groups.some((group) => !group.collapsed);
  const revealMore = useCallback(() => {
    if (visibleCount < totalRows) setVisibleCount((count) => count + 30);
    else if (hasMore && !isLoadingMore) onLoadMore();
  }, [visibleCount, totalRows, hasMore, isLoadingMore, onLoadMore]);
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (
        el.scrollHeight - el.scrollTop - el.clientHeight < 120 &&
        !isLoadingMore &&
        anyExpanded
      ) {
        revealMore();
      }
    },
    [isLoadingMore, revealMore, anyExpanded],
  );

  // Filter out empty groups
  const nonEmptyGroups = groups.filter((g) => g.count > 0);

  if (isLoading && nonEmptyGroups.length === 0)
    return (
      <div
        role="status"
        className="session-list-skeleton space-y-2 p-3"
        aria-label={locale === "zh" ? "正在加载会话" : "Loading sessions"}
      >
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            className="h-16 rounded-lg bg-secondary/50 animate-pulse"
          />
        ))}
      </div>
    );
  if (nonEmptyGroups.length === 0 && !hasMore && !error) {
    return (
      <div className="session-list-empty">
        <SynaxWordmark compact />
        <span className="session-list-empty-label">
          {emptyLabel ?? "No sessions yet"}
        </span>
      </div>
    );
  }

  return (
    <div
      className="session-list-groups flex-1 overflow-y-auto pl-2 pr-0.5 py-1"
      onScroll={onScroll}
    >
      {groups.map((g, index) => {
        const rows = g.sessions.slice(0, visibleCount);
        const contentId = `${groupId}-${g.key}`;
        return (
          <div
            key={g.key}
            className={
              !hideGroupHeaders && index > 0
                ? "session-list-section session-list-section--separated"
                : "session-list-section"
            }
          >
            {!hideGroupHeaders ? (
              <button
                type="button"
                className="list-section-label session-list-section-toggle w-full cursor-pointer"
                onClick={() => onToggleGroup(g.key)}
                aria-expanded={!g.collapsed}
                aria-controls={contentId}
              >
                <ChevronDown
                  size={13}
                  className="session-list-section-chevron"
                  aria-hidden="true"
                />
                {g.key.startsWith("pinned:") && (
                  <Pin size={12} aria-hidden="true" />
                )}
                {g.label}
                <span className="text-muted-foreground/60">· {g.count}</span>
              </button>
            ) : null}
            <div
              id={contentId}
              className="session-list-section-content"
              data-collapsed={g.collapsed}
              aria-hidden={g.collapsed || undefined}
              inert={g.collapsed}
            >
              <div className="session-list-section-rows">
                {rows.map((n) => (
                  <SessionTreeItem
                    key={n.session.id}
                    node={n}
                    isSelected={n.session.id === selectedId}
                    onSelect={onSelect}
                    onToggleExpand={onToggleExpand}
                    onDelete={onDelete}
                    onTogglePin={onTogglePin}
                  />
                ))}
              </div>
            </div>
          </div>
        );
      })}
      {isLoadingMore && (
        <div className="py-3 text-center text-[10px] text-muted-foreground animate-pulse">
          Loading more…
        </div>
      )}
      {error ? (
        <div
          role="alert"
          className="p-3 text-center text-xs text-muted-foreground"
        >
          <p>
            {locale === "zh"
              ? "加载失败，已保留现有会话"
              : "Loading failed. Existing sessions were kept."}
          </p>
          <button type="button" onClick={onRetry} className="mt-2 underline">
            {locale === "zh" ? "重试" : "Retry"}
          </button>
        </div>
      ) : null}
      {anyExpanded && (hasMore || visibleCount < totalRows) && (
        <button
          type="button"
          disabled={isLoadingMore}
          onClick={revealMore}
          className="w-full py-3 text-xs text-muted-foreground"
        >
          {locale === "zh" ? "加载更多" : "Load more"}
        </button>
      )}
    </div>
  );
}
