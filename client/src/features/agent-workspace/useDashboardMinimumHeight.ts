import { useLayoutEffect, type RefObject } from "react";

const BODY =
  ":scope > .dashboard-panel-content > .ws-card > .ws-card-body, :scope > .dashboard-panel-content > .work-runtime-details > .ws-card > .ws-card-body";
const ITEM =
  ".ws-row, .ws-tree-folder, .bui-process-row, .work-todos > li, .ws-card-head, .accordion__trigger, .ws-empty, .runtime-status-details > div:first-child";
const MIN_HEIGHT = "--dashboard-panel-min-height";

/** Keep the first row visible when space permits; share a limited height
 * budget when expanded cards cannot all fit their preferred minimums. */
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
      const measurements: {
        panel: HTMLElement;
        header: number;
        preferred: number;
      }[] = [];
      const panels = [
        ...viewport.querySelectorAll<HTMLElement>("[data-dashboard-panel]"),
      ].filter((panel) => panel.offsetHeight > 0);
      panels.forEach((panel) => {
        const heading = panel.querySelector<HTMLElement>(".ws-card-head");
        const headerHeight = (heading?.offsetHeight ?? 0) + 2;
        if (heading) next.add(heading);
        const body = panel.querySelector<HTMLElement>(BODY);
        const preferred = `${Math.min(420, headerHeight + (body?.scrollHeight ?? 0))}px`;
        if (
          panel.style.getPropertyValue("--dashboard-panel-preferred-height") !==
          preferred
        )
          panel.style.setProperty(
            "--dashboard-panel-preferred-height",
            preferred,
          );
        if (!body) {
          measurements.push({
            panel,
            header: headerHeight,
            preferred: headerHeight,
          });
          return;
        }
        const item =
          [...body.querySelectorAll<HTMLElement>(ITEM)].find(
            (el) =>
              el.getClientRects().length > 0 &&
              el.getBoundingClientRect().height > 0,
          ) ?? (body.firstElementChild as HTMLElement | null);
        if (!item) {
          measurements.push({
            panel,
            header: headerHeight,
            preferred: headerHeight,
          });
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
        measurements.push({
          panel,
          header: headerHeight,
          preferred: Math.max(headerHeight, Math.ceil(bottom + 4)),
        });
      });
      const style = getComputedStyle(viewport);
      const otherChildren = [...viewport.children].filter(
        (el) =>
          el instanceof HTMLElement &&
          !el.hasAttribute("data-dashboard-panel") &&
          getComputedStyle(el).position !== "absolute",
      ) as HTMLElement[];
      for (const child of otherChildren) next.add(child);
      const budget = Math.max(
        0,
        viewport.clientHeight -
          (parseFloat(style.paddingTop) || 0) -
          (parseFloat(style.paddingBottom) || 0) -
          (parseFloat(style.rowGap) || 0) *
            Math.max(0, panels.length + otherChildren.length - 1) -
          otherChildren.reduce((sum, el) => sum + el.offsetHeight, 0),
      );
      const headers = measurements.reduce((sum, item) => sum + item.header, 0);
      const extra = measurements.reduce(
        (sum, item) => sum + item.preferred - item.header,
        0,
      );
      const ratio =
        extra > 0 ? Math.min(1, Math.max(0, budget - headers) / extra) : 0;
      for (const item of measurements) {
        const height = `${Math.floor(item.header + (item.preferred - item.header) * ratio)}px`;
        if (item.panel.style.getPropertyValue(MIN_HEIGHT) !== height)
          item.panel.style.setProperty(MIN_HEIGHT, height);
      }
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
