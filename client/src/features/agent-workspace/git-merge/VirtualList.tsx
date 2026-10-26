import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface VirtualRange {
  start: number;
  end: number;
  offset: number;
  height: number;
  totalHeight: number;
}
const OVERSCAN = 3;

/** Fixed row geometry, one passive scroll listener and one ResizeObserver per mounted window.
 * A scroll frame updates React only when the visible row range changes. */
export function useVirtualWindow(
  count: number,
  rowHeight: number,
  maxHeight: number,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const height = Math.min(count * rowHeight, maxHeight);
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(count, Math.ceil(height / rowHeight) + OVERSCAN),
  }));
  const pendingFocus = useRef<number | null>(null);
  const config = useRef({ count, rowHeight, height });
  config.current = { count, rowHeight, height };

  const measure = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const { count, rowHeight, height } = config.current;
    const available = element.clientHeight || height;
    const top = Math.max(
      0,
      Math.min(element.scrollTop, count * rowHeight - available),
    );
    if (element.scrollTop !== top) element.scrollTop = top;
    const start = Math.max(0, Math.floor(top / rowHeight) - OVERSCAN);
    const end = Math.min(
      count,
      Math.ceil((top + available) / rowHeight) + OVERSCAN,
    );
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
  }, []);

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
  useLayoutEffect(measure, [count, rowHeight, maxHeight, measure]);

  const focusRow = (index: number) => {
    const element = viewport.current;
    if (!element || count === 0) return;
    const target = Math.max(0, Math.min(count - 1, index));
    pendingFocus.current = target;
    const available = element.clientHeight || height;
    const top = target * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + available)
      element.scrollTop = top + rowHeight - available;
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
      : Math.floor((viewport.current?.scrollTop ?? 0) / rowHeight);
    const page = Math.max(
      1,
      Math.floor((viewport.current?.clientHeight || height) / rowHeight),
    );
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
      offset: start * rowHeight,
      height,
      totalHeight: count * rowHeight,
    } satisfies VirtualRange,
  };
}

export function VirtualList<T>({
  items,
  getKey,
  renderRow,
  label,
  rowHeight = 36,
  maxHeight = 252,
  className = "",
  decoration,
  contentStyle,
}: {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderRow: (item: T, index: number) => ReactNode;
  label: string;
  rowHeight?: number;
  maxHeight?: number;
  className?: string;
  decoration?: (range: VirtualRange) => ReactNode;
  contentStyle?: CSSProperties;
}) {
  const { viewport, range, onKeyDown } = useVirtualWindow(
    items.length,
    rowHeight,
    maxHeight,
  );
  if (!items.length) return null;
  return (
    <div
      ref={viewport}
      className={`conversation-git-virtual-window ${className}`}
      style={{ height: range.height }}
      role="region"
      aria-label={label}
      aria-description="可滚动列表，使用上下方向键、Home、End 或翻页键浏览"
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-total-count={items.length}
    >
      <div
        className="conversation-git-virtual-space"
        style={{ height: range.totalHeight }}
      >
        {decoration?.(range)}
        <ol
          className="conversation-git-virtual-rows"
          style={{
            ...contentStyle,
            transform: `translateY(${range.offset}px)`,
          }}
        >
          {items.slice(range.start, range.end).map((item, offset) => {
            const index = range.start + offset;
            return (
              <li
                key={getKey(item, index)}
                data-virtual-index={index}
                aria-posinset={index + 1}
                aria-setsize={items.length}
                style={{ height: rowHeight }}
              >
                {renderRow(item, index)}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
