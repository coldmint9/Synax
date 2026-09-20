import { useLayoutEffect, type RefObject } from "react";

const BODY =
  ":scope > .dashboard-panel-content > .ws-card > .ws-card-body, :scope > .dashboard-panel-content > .work-runtime-details > .ws-card > .ws-card-body";
const ITEM =
  ".ws-row, .ws-tree-folder, .bui-process-row, .work-todos > li, .ws-card-head, .accordion__trigger, .ws-empty";
const MIN_HEIGHT = "--dashboard-panel-min-height";

/** Include the actual toolbar, list heading and first item, rather than a
 * fixed height that can leave the entire list below the viewport. */
export function useDashboardMinimumHeight(
  root: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const viewport = root.current;
    if (!viewport) return;
    let frame = 0;
    let observed = new Set<Element>();
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const measure = () => {
      frame = 0;
      const next = new Set<Element>([viewport]);
      viewport
        .querySelectorAll<HTMLElement>("[data-dashboard-panel]")
        .forEach((panel) => {
          const body = panel.querySelector<HTMLElement>(BODY);
          if (!body) {
            panel.style.removeProperty(MIN_HEIGHT);
            return;
          }
          const item =
            [...body.querySelectorAll<HTMLElement>(ITEM)].find(
              (el) =>
                el.getClientRects().length > 0 &&
                el.getBoundingClientRect().height > 0,
            ) ?? (body.firstElementChild as HTMLElement | null);
          if (!item) {
            panel.style.removeProperty(MIN_HEIGHT);
            return;
          }
          const card = body.parentElement!;
          const header = card.querySelector(":scope > .ws-card-head");
          next.add(card);
          next.add(item);
          if (header) next.add(header);
          const bounds = panel.getBoundingClientRect();
          const scale =
            panel.offsetWidth > 0 ? bounds.width / panel.offsetWidth : 1;
          if (!scale) return;
          // Rectangles reflect scrolling and CSS zoom; recover layout pixels.
          let scrollOffset = 0;
          for (
            let parent = item.parentElement;
            parent && parent !== panel;
            parent = parent.parentElement
          )
            scrollOffset += parent.scrollTop;
          const bottom =
            (item.getBoundingClientRect().bottom - bounds.top) / scale +
            scrollOffset;
          // Leave room for the corner resize handle below the first complete row.
          const height = `${Math.ceil(bottom + 18)}px`;
          if (panel.style.getPropertyValue(MIN_HEIGHT) !== height)
            panel.style.setProperty(MIN_HEIGHT, height);
        });
      for (const el of observed) if (!next.has(el)) resize.unobserve(el);
      for (const el of next) if (!observed.has(el)) resize.observe(el);
      observed = next;
    };
    const mutations = new MutationObserver(schedule);
    mutations.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-open", "aria-expanded", "hidden"],
    });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [root]);
}
