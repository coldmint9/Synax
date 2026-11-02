import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ActivityRowScope } from "./ActivityRowScope";
import { useAppendedEntryIds } from "./useAppendedEntryIds";

export interface ActivityWindowRow {
  key: string;
  node: ReactNode;
  /**
   * Fixed height for a collapsed row that paints inline media below its one
   * line. Omitted rows keep the window's uniform `rowHeight`.
   */
  height?: number;
}

interface Props {
  /** Session/round/epoch identity; retain reading position across virtual unmounts. */
  rememberKey?: string;
  rows: readonly ActivityWindowRow[];
  /**
   * A live turn keeps a fixed window over its records and follows the newest
   * one. A finished turn lays the same rows out in place, so completing a turn
   * never remounts the rows the reader just opened.
   */
  windowed?: boolean;
  animate?: boolean;
  /** Collapsed record rows the window is tall enough to show. */
  visibleRows?: number;
  /** Height of one record row, in px. */
  rowHeight?: number;
}

const OVERSCAN_ROWS = 3;
/** How close to an edge still counts as being at that edge, in px. */
const EDGE_SLOP = 2;
type ActivityWindowPosition = { top: number; following: boolean; expandedKey: string | null; expandedHeight: number };
const positions = new Map<string, ActivityWindowPosition>();

function ActivityWindowRecord({ row, compact, expanded, appended, claimRow, measure }: {
  row: ActivityWindowRow & { departing: boolean };
  compact: boolean;
  expanded: boolean;
  appended: boolean;
  claimRow: (key: string) => void;
  measure: (node: HTMLDivElement | null) => void;
}) {
  // A new call must not change every existing row's context callback and
  // defeat the call-summary memoization.
  const expand = useCallback(() => claimRow(row.key), [claimRow, row.key]);
  return (
    <div ref={expanded ? measure : undefined} data-row-key={row.key}
      style={compact && !expanded && row.height ? { height: row.height } : undefined}
      data-row-appended={appended || undefined} data-row-expanded={expanded || undefined}
      data-departing={row.departing || undefined} aria-hidden={row.departing || undefined}
      inert={row.departing || undefined} className="session-process-window-row">
      <ActivityRowScope compact={compact} active={!compact || expanded} onExpand={compact ? expand : undefined}>
        {row.node}
      </ActivityRowScope>
    </div>
  );
}

/**
 * Fixed-height window over one-line activity records.
 *
 * The window owns the row contract, so the geometry stays arithmetic:
 *
 *   frame      visual layer — the edge fades that report content off-screen
 *   viewport   scroll layer — a height budget of `visibleRows * rowHeight`
 *   row        a block box of exactly `rowHeight`, or its own height when it
 *              paints an inline media strip, while collapsed
 *
 * Collapsed rows never measure themselves, so offsets come from each row's
 * declared height and only the rows near the window mount. Opening one record
 * is the single exception: that row reports its natural height, the window
 * keeps every other row on its fixed budget, and virtualization stays on.
 * Opening one record must never unfold the whole list.
 */
export function VirtualActivityWindow({
  rememberKey,
  rows,
  windowed = false,
  animate = false,
  visibleRows = 7,
  rowHeight = 30,
}: Props) {
  const [saved] = useState(() => rememberKey ? positions.get(rememberKey) : undefined);
  const viewport = useRef<HTMLDivElement | null>(null);
  const previousRows = useRef(rows);
  const [knownKeys, setKnownKeys] = useState(() => rows.map((row) => row.key));
  const [departing, setDeparting] = useState<Array<{ row: ActivityWindowRow; index: number }>>([]);
  // Keep removed records just long enough to fade out. Limit this to the
  // visible tail so a history replacement never retains an entire transcript.
  // Adjust before committing: an effect would first unmount a removed row,
  // then create a replacement, losing its DOM identity and disclosure state.
  if (knownKeys.length !== rows.length || rows.some((row, index) => row.key !== knownKeys[index])) {
    setKnownKeys(rows.map((row) => row.key));
    if (animate) {
      const keys = new Set(rows.map((row) => row.key));
      const removed = previousRows.current
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => !keys.has(row.key))
        .slice(-visibleRows);
      if (removed.length) setDeparting(removed);
    }
  }
  useLayoutEffect(() => {
    previousRows.current = rows;
  }, [rows]);
  useEffect(() => {
    if (!departing.length) return;
    if (!animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setDeparting([]);
      return;
    }
    const timer = window.setTimeout(() => setDeparting([]), 160);
    return () => window.clearTimeout(timer);
  }, [departing, animate]);
  /** False once the reader opens a record or scrolls away from the newest one. */
  const following = useRef(saved?.following ?? true);
  const manualUntil = useRef(0);
  const markManualScroll = () => { manualUntil.current = performance.now() + 1000; };
  /** The one record the reader opened; every other row stays one line. */
  const [expandedKey, setExpandedKey] = useState<string | null>(saved?.expandedKey ?? null);
  const [expandedHeight, setExpandedHeight] = useState(saved?.expandedHeight ?? rowHeight);
  const observer = useRef<ResizeObserver | null>(null);

  const claimRow = useCallback(
    (key: string) => {
      following.current = false;
      setExpandedHeight(rowHeight);
      setExpandedKey(key);
    },
    [rowHeight],
  );

  // Only the opened row is measured, and only while it is mounted. A row that
  // scrolls out of the window keeps its last measured height, so the scroll
  // range never collapses under the reader.
  const measureExpandedRow = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const measure = () => {
      const height = node.getBoundingClientRect().height;
      if (height <= 0) return;
      setExpandedHeight((previous) => (Math.abs(previous - height) < 0.5 ? previous : height));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const next = new ResizeObserver(measure);
    next.observe(node);
    observer.current = next;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  const renderedRows = rows.map((row) => ({ ...row, departing: false }));
  const keys = new Set(rows.map((row) => row.key));
  if (animate) for (const { row, index } of departing) {
    if (!keys.has(row.key)) renderedRows.splice(Math.min(index, renderedRows.length), 0, { ...row, departing: true });
  }

  const expandedIndex = expandedKey === null
    ? -1
    : renderedRows.findIndex((row) => row.key === expandedKey && !row.departing);
  /** Pixel offset of every row; only the opened row differs from `rowHeight`. */
  const offsets = new Array<number>(renderedRows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < renderedRows.length; index += 1) {
    offsets[index + 1] =
      offsets[index] +
      (index === expandedIndex
        ? expandedHeight
        : renderedRows[index].height ?? rowHeight);
  }
  const totalHeight = offsets[renderedRows.length];
  const budget = visibleRows * rowHeight;
  const scrollable = windowed && totalHeight > budget;
  const [scrollTop, setScrollTop] = useState(() =>
    saved && !saved.following ? Math.min(saved.top, Math.max(0, totalHeight - budget)) :
    windowed ? Math.max(0, totalHeight - budget) : 0,
  );
  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = scrollTop;
  }, []);
  useLayoutEffect(() => {
    if (!rememberKey) return;
    positions.delete(rememberKey);
    positions.set(rememberKey, { top: scrollTop, following: following.current, expandedKey, expandedHeight });
    if (positions.size > 500) positions.delete(positions.keys().next().value!);
  }, [rememberKey, scrollTop, expandedKey, expandedHeight]);
  const rowIds = useMemo(() => rows.map(row => ({ id: row.key })), [rows]);
  const appended = useAppendedEntryIds(rowIds, rememberKey);

  // Every commit changes either the row count, the opened row or the reader's
  // position: keep the newest record in view unless the reader took over.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !scrollable || !following.current) return;
    const newest = Math.max(0, totalHeight - budget);
    if (Math.abs(element.scrollTop - newest) > EDGE_SLOP) element.scrollTop = newest;
    setScrollTop((previous) => (previous === newest ? previous : newest));
  });

  // An opened record that grows past the window's bottom edge brings its own
  // body into view. Rows that still fit stay where the reader clicked them.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !scrollable || expandedIndex < 0) return;
    const top = offsets[expandedIndex];
    const bottom = top + expandedHeight;
    if (bottom <= element.scrollTop + budget) return;
    const target = expandedHeight >= budget ? top : bottom - budget;
    if (Math.abs(element.scrollTop - target) < 0.5) return;
    element.scrollTop = target;
    setScrollTop(target);
  }, [budget, expandedHeight, expandedIndex, rowHeight, scrollable]);

  let start = 0;
  let end = renderedRows.length;
  if (scrollable) {
    while (start < renderedRows.length && offsets[start + 1] <= scrollTop) start += 1;
    start = Math.max(0, start - OVERSCAN_ROWS);
    end = start;
    while (end < renderedRows.length && offsets[end] < scrollTop + budget) end += 1;
    end = Math.min(
      renderedRows.length,
      Math.max(start + visibleRows, end + OVERSCAN_ROWS),
    );
  }
  const fadeTop = scrollable && scrollTop > EDGE_SLOP;
  const fadeBottom = scrollable && scrollTop + budget < totalHeight - EDGE_SLOP;

  return (
    <div
      className="session-process-window-frame"
      data-animate={animate || undefined}
      data-fade-top={fadeTop || undefined}
      data-fade-bottom={fadeBottom || undefined}
    >
      <div
        ref={viewport}
        className="session-process-window-viewport"
        data-windowed={windowed || undefined}
        onWheel={markManualScroll}
        onTouchMove={markManualScroll}
        onPointerDown={markManualScroll}
        onKeyDown={event => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) markManualScroll();
        }}
        style={
          windowed
            ? ({
                "--process-row-h": `${rowHeight}px`,
                maxHeight: `${budget}px`,
                height: `${Math.min(totalHeight, budget)}px`,
              } as CSSProperties)
            : undefined
        }
        onScroll={
          scrollable
            ? (event) => {
                const element = event.currentTarget;
                // Spacer commits can clamp a programmatic tail scroll. They
                // must not be mistaken for the reader leaving the live edge.
                if (following.current && performance.now() > manualUntil.current) return;
                following.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight <= EDGE_SLOP;
                setScrollTop(element.scrollTop);
              }
            : undefined
        }
      >
        {start > 0 && (
          <div
            aria-hidden="true"
            className="session-process-window-spacer"
            style={{ height: offsets[start] }}
          />
        )}
        {renderedRows.slice(start, end).map(row => (
          <ActivityWindowRecord key={row.key} row={row} compact={windowed}
            expanded={!row.departing && row.key === expandedKey}
            appended={animate && appended.has(row.key)} claimRow={claimRow} measure={measureExpandedRow} />
        ))}
        {end < renderedRows.length && (
          <div
            aria-hidden="true"
            className="session-process-window-spacer"
            style={{ height: offsets[renderedRows.length] - offsets[end] }}
          />
        )}
      </div>
    </div>
  );
}
