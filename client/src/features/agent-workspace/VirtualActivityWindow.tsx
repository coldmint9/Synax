import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface ActivityWindowRow {
  key: string;
  node: ReactNode;
}

interface Props {
  rows: readonly ActivityWindowRow[];
  /**
   * A live turn keeps a fixed window over its records and follows the newest
   * one. Finished turns render every row in place, in the same DOM shape, so
   * completing a turn never remounts the rows the reader just opened.
   */
  windowed?: boolean;
  /** Collapsed record rows the window is tall enough to show. */
  visibleRows?: number;
  /** Height of one collapsed record row, in px. */
  rowHeight?: number;
}

const OVERSCAN_ROWS = 3;

/**
 * Virtual list for one-line activity records.
 *
 * Every record is a row of roughly one line, so the window can be a fixed
 * height while only the rows inside it stay mounted. Heights are still measured
 * because a row that the reader expands grows past one line; the measurement
 * only has to survive while that row is rendered.
 */
export function VirtualActivityWindow({
  rows,
  windowed = false,
  visibleRows = 7,
  rowHeight = 30,
}: Props) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const stickToNewest = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>({});

  const measure = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const measured: Record<string, number> = {};
    element.querySelectorAll<HTMLElement>("[data-row-key]").forEach((node) => {
      const key = node.dataset.rowKey;
      const height = node.getBoundingClientRect().height;
      if (key && height > 0) measured[key] = height;
    });
    setHeights((previous) => {
      for (const key of Object.keys(measured)) {
        if (previous[key] !== measured[key]) return { ...previous, ...measured };
      }
      return previous;
    });
  }, []);

  // Runs after every commit: streaming rows change height without a scroll.
  const follow = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const height = element.clientHeight;
    setViewportHeight((previous) => (previous === height ? previous : height));
    if (!windowed || !stickToNewest.current) return;
    const overflow = element.scrollHeight - element.clientHeight;
    if (element.scrollTop < overflow - 1) {
      element.scrollTop = overflow;
      setScrollTop(element.scrollTop);
    }
  }, [windowed]);

  useLayoutEffect(() => {
    measure();
    follow();
  });

  // One observer for the window's own size; rows only change when they render.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [follow]);

  const offsets: number[] = new Array(rows.length);
  let totalHeight = 0;
  for (let index = 0; index < rows.length; index += 1) {
    offsets[index] = totalHeight;
    totalHeight += heights[rows[index].key] ?? rowHeight;
  }

  const active = windowed && viewportHeight > 0;
  let start = 0;
  let end = rows.length;
  if (active) {
    while (
      start < rows.length &&
      offsets[start] + (heights[rows[start].key] ?? rowHeight) <= scrollTop
    ) {
      start += 1;
    }
    start = Math.max(0, start - OVERSCAN_ROWS);
    const limit = scrollTop + viewportHeight + OVERSCAN_ROWS * rowHeight;
    end = start;
    while (end < rows.length && offsets[end] < limit) end += 1;
    end = Math.min(rows.length, Math.max(end, start + 1));
  }

  const fading =
    active &&
    totalHeight > viewportHeight + 1 &&
    scrollTop + viewportHeight < totalHeight - 1;

  return (
    <div className="session-process-window-frame" data-fade={fading || undefined}>
      <div
        ref={viewport}
        className="session-process-window-viewport"
        data-windowed={windowed || undefined}
        style={windowed ? { maxHeight: rowHeight * visibleRows } : undefined}
        onScroll={
          windowed
            ? (event) => {
                const element = event.currentTarget;
                stickToNewest.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
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
        {rows.slice(start, end).map((row) => (
          <div key={row.key} data-row-key={row.key} className="session-process-window-row">
            {row.node}
          </div>
        ))}
        {end < rows.length && (
          <div
            aria-hidden="true"
            className="session-process-window-spacer"
            style={{ height: totalHeight - offsets[end] }}
          />
        )}
      </div>
    </div>
  );
}
