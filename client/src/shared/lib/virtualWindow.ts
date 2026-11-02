import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export interface VirtualRange {
  start: number;
  end: number;
  offset: number;
  height: number;
  totalHeight: number;
}
const OVERSCAN = 3;

/** Row heights for `rowHeights`, as prefix sums; `offsets[i]` is row i's top. */
function prefixHeights(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    offsets[index + 1] = offsets[index] + Math.max(heights[index] ?? 0, 1);
  }
  return offsets;
}

/** Largest row index whose top is at or above `offset`. */
function rowIndexAt(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 2;
  if (high < 0) return 0;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Fixed row geometry, one passive scroll listener and one ResizeObserver per mounted window.
 * A scroll frame updates React only when the visible row range changes.
 *
 * `rowHeights` switches the window to mixed-height rows (a group header next to
 * cards). Rows are then located through prefix sums and a binary search, so the
 * rendered slice stays exact instead of assuming one height for all rows.
 */
export function useVirtualWindow(
  count: number,
  rowHeight: number,
  maxHeight: number,
  rowHeights?: readonly number[],
) {
  const viewport = useRef<HTMLDivElement>(null);
  const mixed = Boolean(rowHeights && rowHeights.length === count);
  const offsets = useMemo(
    () => (mixed && rowHeights ? prefixHeights(rowHeights) : null),
    [mixed, rowHeights],
  );
  const totalHeight = offsets ? offsets[count] : count * rowHeight;
  const height = Math.min(totalHeight, maxHeight);
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(count, Math.ceil(height / rowHeight) + OVERSCAN),
  }));
  const pendingFocus = useRef<number | null>(null);
  const config = useRef({ count, rowHeight, height, offsets, totalHeight });
  config.current = { count, rowHeight, height, offsets, totalHeight };

  const offsetOf = useCallback((index: number) => {
    const { offsets: current, rowHeight: uniform } = config.current;
    return current ? current[Math.min(index, current.length - 1)] : index * uniform;
  }, []);
  const rowHeightOf = useCallback((index: number) => {
    const { offsets: current, rowHeight: uniform } = config.current;
    if (!current) return uniform;
    return Math.max(current[Math.min(index + 1, current.length - 1)] - current[Math.min(index, current.length - 1)], 1);
  }, []);
  const indexOf = useCallback((scrollTop: number) => {
    const { offsets: current, rowHeight: uniform, count: rows } = config.current;
    if (!current) return Math.min(rows - 1, Math.floor(scrollTop / uniform));
    return Math.min(rows - 1, rowIndexAt(current, scrollTop));
  }, []);

  const measure = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const { count, height, totalHeight } = config.current;
    const available = element.clientHeight || height;
    const top = Math.max(0, Math.min(element.scrollTop, totalHeight - available));
    if (element.scrollTop !== top) element.scrollTop = top;
    const start = Math.max(0, indexOf(top) - OVERSCAN);
    const lastVisible = indexOf(top + available);
    const end = Math.min(count, Math.max(start, lastVisible + 1 + OVERSCAN));
    // Wheel-scrolling a focused row out must not drop keyboard focus into the document.
    const active = document.activeElement?.closest<HTMLElement>(
      "[data-virtual-index]",
    );
    if (pendingFocus.current === null && active && element.contains(active)) {
      const index = Number(active.dataset.virtualIndex);
      if (index < start || index >= end) element.focus({ preventScroll: true });
    }
    setRange((previous) =>
      previous.start === start && previous.end === end
        ? previous
        : { start, end },
    );
  }, [indexOf]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    element.addEventListener("scroll", schedule, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(element);
    measure();
    return () => {
      element.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [measure, count > 0]);
  useLayoutEffect(measure, [count, rowHeight, maxHeight, offsets, measure]);

  const focusRow = (index: number) => {
    const element = viewport.current;
    if (!element || count === 0) return;
    const target = Math.max(0, Math.min(count - 1, index));
    pendingFocus.current = target;
    const available = element.clientHeight || height;
    const top = offsetOf(target);
    const targetHeight = rowHeightOf(target);
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + targetHeight > element.scrollTop + available)
      element.scrollTop = top + targetHeight - available;
    measure();
    const existing = element.querySelector<HTMLElement>(
      `[data-virtual-index="${target}"] button, [data-virtual-index="${target}"] a`,
    );
    if (existing) {
      existing.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  };
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const target = viewport.current?.querySelector<HTMLElement>(
      `[data-virtual-index="${pendingFocus.current}"] button, [data-virtual-index="${pendingFocus.current}"] a`,
    );
    if (target) {
      target.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      (event.target instanceof HTMLElement &&
        event.target.matches("input, textarea, select"))
    )
      return;
    const active = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-virtual-index]",
    );
    const index = active
      ? Number(active.dataset.virtualIndex)
      : indexOf(viewport.current?.scrollTop ?? 0);
    const pageHeight = viewport.current?.clientHeight || height;
    const averageRow = Math.max(1, Math.round((config.current.totalHeight || rowHeight) / Math.max(count, 1)));
    const page = Math.max(1, Math.floor(pageHeight / averageRow));
    const next = {
      ArrowDown: index + (active ? 1 : 0),
      ArrowUp: index - 1,
      Home: 0,
      End: count - 1,
      PageDown: index + page,
      PageUp: index - page,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    focusRow(next);
  };
  const start = Math.min(range.start, Math.max(0, count - 1));
  const end = Math.min(count, Math.max(start, range.end));
  return {
    viewport,
    onKeyDown,
    range: {
      start,
      end,
      offset: offsetOf(start),
      height,
      totalHeight,
    } satisfies VirtualRange,
  };
}
