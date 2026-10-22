import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ActivityRowScope } from "./ActivityRowScope";

export interface ActivityWindowRow {
  key: string;
  node: ReactNode;
}

interface Props {
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

/**
 * Fixed-height window over one-line activity records.
 *
 * The window owns the row contract, so the geometry stays arithmetic:
 *
 *   frame      visual layer — the edge fades that report content off-screen
 *   viewport   scroll layer — a height budget of `visibleRows * rowHeight`
 *   row        a block box of exactly `rowHeight`, never a flex item that can
 *              shrink under its content
 *
 * Because rows inside the window are one line each (see ActivityRowScope), the
 * offsets are `index * rowHeight` and only the rows near the window mount.
 * Nothing measures the DOM, so a record can never be squeezed into a
 * neighbouring one.
 *
 * The fixed geometry is a reading aid, not a lock: a row that the reader opens
 * takes the window over, and the list then lays its records out in place.
 */
export function VirtualActivityWindow({
  rows,
  windowed: liveWindow = false,
  animate = false,
  visibleRows = 7,
  rowHeight = 30,
}: Props) {
  // The reader can take the window: opening a record stops the fixed row budget
  // so the body gets its natural height instead of dropping the disclosure.
  const [readerOwned, setReaderOwned] = useState(false);
  const takeOver = useCallback(() => setReaderOwned(true), []);
  const windowed = liveWindow && !readerOwned;
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
  const renderedRows = rows.map((row) => ({ ...row, departing: false }));
  const keys = new Set(rows.map((row) => row.key));
  if (animate) for (const { row, index } of departing) {
    if (!keys.has(row.key)) renderedRows.splice(Math.min(index, renderedRows.length), 0, { ...row, departing: true });
  }
  /** False once the reader scrolls away from the newest record. */
  const following = useRef(true);
  const totalHeight = renderedRows.length * rowHeight;
  const budget = visibleRows * rowHeight;
  const scrollable = windowed && totalHeight > budget;
  const [scrollTop, setScrollTop] = useState(() =>
    windowed ? Math.max(0, totalHeight - budget) : 0,
  );

  // Every commit changes either the row count or the reader's position: keep
  // the newest record in view unless the reader took over the window.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !scrollable || !following.current) return;
    const newest = Math.max(0, totalHeight - budget);
    if (Math.abs(element.scrollTop - newest) > EDGE_SLOP) element.scrollTop = newest;
    setScrollTop((previous) => (previous === newest ? previous : newest));
  });

  let start = 0;
  let end = renderedRows.length;
  if (scrollable) {
    start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
    end = Math.min(
      renderedRows.length,
      Math.max(visibleRows, Math.ceil((scrollTop + budget) / rowHeight)) + OVERSCAN_ROWS,
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
            style={{ height: start * rowHeight }}
          />
        )}
        {renderedRows.slice(start, end).map((row) => (
          <div key={row.key} data-row-key={row.key} data-departing={row.departing || undefined} aria-hidden={row.departing || undefined} inert={row.departing || undefined} className="session-process-window-row">
            <ActivityRowScope compact={windowed} onTakeOver={takeOver}>{row.node}</ActivityRowScope>
          </div>
        ))}
        {end < renderedRows.length && (
          <div
            aria-hidden="true"
            className="session-process-window-spacer"
            style={{ height: (renderedRows.length - end) * rowHeight }}
          />
        )}
      </div>
    </div>
  );
}
