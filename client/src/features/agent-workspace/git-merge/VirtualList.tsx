import {
  type CSSProperties,
  type ReactNode,
} from "react";
import { useVirtualWindow, type VirtualRange } from "@/shared/lib/virtualWindow";

export { useVirtualWindow, type VirtualRange };

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
  spaceStyle,
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
  spaceStyle?: CSSProperties;
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
        style={{ ...spaceStyle, height: range.totalHeight }}
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
