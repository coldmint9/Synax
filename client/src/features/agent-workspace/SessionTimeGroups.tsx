import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SESSION_PAGE_SIZE } from "../../shared/lib/sessionListPaging";
import "./sessionListReveal.css";
import { useLocale } from "../../shared/hooks/useLocale";
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
  onLoadMore: () => void | Promise<void>;
  onDelete: (id: string) => void;
  onTogglePin?: (id: string) => Promise<void>;
}

/** Initial rows do not animate; a newly mounted page expands only once. */
function SessionListReveal({ reveal, children }: { reveal: boolean; children: ReactNode }) {
  const [revealing, setRevealing] = useState(reveal);
  useEffect(() => {
    if (!revealing) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const settle = () => { if (motion.matches) setRevealing(false); };
    settle();
    motion.addEventListener("change", settle);
    return () => motion.removeEventListener("change", settle);
  }, [revealing]);
  return (
    <div
      className="session-list-reveal"
      data-revealing={revealing || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setRevealing(false);
      }}
    >
      <div className="session-list-reveal-content">{children}</div>
    </div>
  );
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
  const listId = `${groupId}-list`;
  const [visibleCount, setVisibleCount] = useState(SESSION_PAGE_SIZE);
  const [revealBaseline, setRevealBaseline] = useState<Set<string> | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const pageRequested = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // One budget across all groups. Only pinned sections can collapse;
  // keep their rows mounted without hiding ordinary conversations.
  let remaining = visibleCount;
  const visibleGroups = groups.map((group) => {
    const rows = group.sessions.slice(0, remaining);
    remaining -= rows.length;
    return { ...group, rows, collapsed: group.key.startsWith("pinned:") && group.collapsed };
  });
  const totalRows = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  const anyExpanded = visibleGroups.some((group) => !group.collapsed);
  const busy = isLoadingMore || requesting;
  const canReveal = hasMore || visibleCount < totalRows;
  const revealMore = async () => {
    if (pending.current || busy || !canReveal) return;
    setPageFailed(false);
    setRevealBaseline(new Set(visibleGroups.flatMap((group) => group.rows.map((node) => node.session.id))));
    // Base the next batch on actual rows. A failed request must not accumulate
    // unused page allowances and reveal 40+ rows on a later retry.
    setVisibleCount(Math.min(visibleCount, totalRows) + SESSION_PAGE_SIZE);
    if (visibleCount < totalRows) return;
    pending.current = true;
    pageRequested.current = true;
    setRequesting(true);
    try {
      await onLoadMore();
    } catch {
      if (mounted.current) setPageFailed(true);
    } finally {
      pending.current = false;
      if (mounted.current) setRequesting(false);
    }
  };

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
        {/* <SynaxWordmark compact /> */}
        <span className="session-list-empty-label">
          {emptyLabel ?? "No sessions yet"}
        </span>
      </div>
    );
  }

  return (
    <div
      className="session-list-groups flex-1 overflow-y-auto pl-2 pr-0.5 py-1"
      id={listId}
      aria-busy={busy}
    >
      {visibleGroups.map((g, index) => {
        const rows = g.rows;
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
            {!hideGroupHeaders && g.key.startsWith("pinned:") ? (
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
                {g.label}
                <span className="text-muted-foreground/60">· {g.count}</span>
              </button>
            ) : !hideGroupHeaders ? (
              <div className="list-section-label session-list-section-label w-full">
                {g.label}
                <span className="text-muted-foreground/60">· {g.count}</span>
              </div>
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
                  <SessionListReveal
                    key={n.session.id}
                    reveal={revealBaseline !== null && !revealBaseline.has(n.session.id)}
                  >
                    <SessionTreeItem
                      node={n}
                      isSelected={n.session.id === selectedId}
                      onSelect={onSelect}
                      onToggleExpand={onToggleExpand}
                      onDelete={onDelete}
                      onTogglePin={onTogglePin}
                    />
                  </SessionListReveal>
                ))}
              </div>
            </div>
          </div>
        );
      })}
      {(error || pageFailed) && !busy ? (
        <div
          role="alert"
          className="p-3 text-center text-xs text-muted-foreground"
        >
          <p>
            {locale === "zh"
              ? "加载失败，已保留现有会话"
              : "Loading failed. Existing sessions were kept."}
          </p>
          <button
            type="button"
            onClick={pageRequested.current ? () => void revealMore() : onRetry}
            className="mt-2 underline"
          >
            {locale === "zh" ? "重试" : "Retry"}
          </button>
        </div>
      ) : null}
      {(anyExpanded || totalRows === 0) && (canReveal || busy) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void revealMore()}
          aria-controls={listId}
          className="session-list-expand-more w-full py-3 text-xs text-muted-foreground"
        >
          {busy
            ? locale === "zh" ? "正在加载…" : "Loading…"
            : locale === "zh" ? "展开更多" : "Show more"}
        </button>
      )}
    </div>
  );
}
