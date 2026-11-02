import { useCallback, useRef, type KeyboardEvent } from "react";

export type ToolbarFocusOrientation = "horizontal" | "vertical";

const ARROW_STEPS: Record<ToolbarFocusOrientation, Record<string, number>> = {
  horizontal: { ArrowRight: 1, ArrowLeft: -1 },
  vertical: { ArrowDown: 1, ArrowUp: -1 },
};

const FOCUSABLE = '[data-toolbar-focus]:not(:disabled):not([aria-disabled="true"])';

function focusableItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

function resolveIndex(items: readonly HTMLElement[], active: HTMLElement | null): number {
  if (!active) return -1;
  const direct = items.indexOf(active);
  return direct >= 0 ? direct : items.findIndex((item) => item.contains(active));
}

function isRightToLeft(container: HTMLElement): boolean {
  const scoped = container.closest<HTMLElement>("[dir]");
  return (scoped?.dir || document.documentElement.dir) === "rtl";
}

/**
 * Arrow/Home/End navigation for one toolbar group. A single delegated listener
 * lives on the container, so adding controls never adds listeners or handlers.
 */
export function useToolbarRovingFocus<T extends HTMLElement>(
  orientation: ToolbarFocusOrientation = "horizontal",
) {
  const ref = useRef<T>(null);
  const onKeyDown = useCallback(
    (event: KeyboardEvent<T>) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const container = ref.current;
      if (!container) return;
      const items = focusableItems(container);
      if (items.length === 0) return;

      const current = resolveIndex(
        items,
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
      );
      const step = ARROW_STEPS[orientation][event.key];
      let next: number | null = null;
      if (step !== undefined) {
        // A right-to-left surface reverses only the horizontal arrows.
        const direction = isRightToLeft(container) ? -step : step;
        next =
          current < 0
            ? direction > 0
              ? 0
              : items.length - 1
            : (current + direction + items.length) % items.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = items.length - 1;
      }
      if (next === null) return;
      event.preventDefault();
      items[next]?.focus();
    },
    [orientation],
  );
  return { ref, onKeyDown } as const;
}
