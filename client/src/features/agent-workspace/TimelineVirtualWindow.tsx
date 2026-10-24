import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ConversationTimelineEntry } from "./buildConversationTimeline";
import { estimateEntryHeight } from "./TimelineLazyEntry";

const GAP = 20;
const OVERSCAN = 900;
type Measurements = { width: number; heights: Map<string, number> };
const measurements = new Map<string, Measurements>();
type Navigation = { offset: (id: string) => number | undefined; jump: (id: string) => boolean; anchor: (id: string, top: number) => boolean };
const navigation = new WeakMap<HTMLElement, Navigation>();
export function virtualEntryOffset(root: HTMLElement, id: string): number | undefined {
  return navigation.get(root)?.offset(id);
}
export function scrollToVirtualEntry(root: HTMLElement, id: string): boolean {
  return navigation.get(root)?.jump(id) ?? false;
}
export function anchorVirtualEntry(root: HTMLElement, id: string, top: number): boolean {
  return navigation.get(root)?.anchor(id, top) ?? false;
}
function cacheFor(key: string): Measurements {
  let cache = measurements.get(key);
  if (!cache) cache = { width: 0, heights: new Map() };
  measurements.delete(key);
  measurements.set(key, cache);
  if (measurements.size > 32) measurements.delete(measurements.keys().next().value!);
  return cache;
}
function rowAt(offsets: number[], top: number): number {
  let lo = 0, hi = offsets.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (offsets[mid] <= top) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** One measured, variable-height window for the entire transcript, including live rows. */
export function TimelineVirtualWindow({ entries, scrollRootRef, cacheKey, renderRows }: {
  entries: ConversationTimelineEntry[];
  scrollRootRef?: RefObject<HTMLElement | null>;
  cacheKey: string;
  renderRows: (entries: ConversationTimelineEntry[], start: number) => ReactNode[];
}) {
  const list = useRef<HTMLDivElement>(null);
  const cache = useMemo(() => cacheFor(cacheKey), [cacheKey]);
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState({ top: Infinity, height: 800 });
  const layout = useMemo(() => {
    const offsets: number[] = [];
    const indices = new Map<string, number>();
    let total = 0;
    entries.forEach((entry, index) => {
      offsets.push(total);
      indices.set(entry.id, index);
      total += cache.heights.get(entry.id) ?? estimateEntryHeight(entry) + GAP;
    });
    return { entries, offsets, indices, total };
  }, [entries, cache, revision]);
  const current = useRef(layout);
  current.current = layout;
  const previous = useRef(layout);
  const readingAnchor = useRef<string | null>(null);
  const listOffset = useCallback(() => {
    const root = scrollRootRef?.current;
    return root && list.current ? list.current.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop : 0;
  }, [scrollRootRef]);
  const updateViewport = useCallback(() => {
    const root = scrollRootRef?.current;
    if (!root || root.clientHeight === 0) return;
    const next = { top: root.scrollTop - listOffset(), height: root.clientHeight };
    setViewport(old => old.top === next.top && old.height === next.height ? old : next);
  }, [scrollRootRef, listOffset]);
  const top = Number.isFinite(viewport.top) ? viewport.top : Math.max(0, layout.total - viewport.height);
  const start = scrollRootRef ? rowAt(layout.offsets, Math.max(0, top - OVERSCAN)) : 0;
  const end = scrollRootRef ? Math.min(entries.length, rowAt(layout.offsets, top + viewport.height + OVERSCAN) + 1) : entries.length;

  useLayoutEffect(() => {
    const root = scrollRootRef?.current;
    if (!root) return;
    const old = previous.current;
    // A batch eviction removes a prefix. Keep the same row under the reader;
    // prepends are anchored by useOlderTranscriptHistory before paint.
    if (old !== layout && old.entries[0] && !layout.indices.has(old.entries[0].id)) {
      const oldTop = root.scrollTop - listOffset();
      const index = rowAt(old.offsets, oldTop);
      const nextIndex = layout.indices.get(old.entries[index]?.id);
      if (nextIndex !== undefined) root.scrollTop += layout.offsets[nextIndex] - old.offsets[index];
    }
    previous.current = layout;
    const api: Navigation = {
      offset: id => {
        const index = current.current.indices.get(id);
        return index === undefined ? undefined : listOffset() + current.current.offsets[index];
      },
      jump: id => {
        const offset = api.offset(id);
        if (offset === undefined) return false;
        root.dispatchEvent(new Event("transcript-history-reading"));
        readingAnchor.current = id;
        root.scrollTop = Math.max(0, offset - root.clientHeight * 0.35);
        updateViewport();
        return true;
      },
      anchor: (id, top) => {
        const offset = api.offset(id);
        if (offset === undefined) return false;
        readingAnchor.current = id;
        root.scrollTop = offset - top;
        updateViewport();
        return true;
      },
    };
    navigation.set(root, api);
    updateViewport();
    return () => { if (navigation.get(root) === api) navigation.delete(root); };
  }, [layout, scrollRootRef, listOffset, updateViewport]);

  useEffect(() => {
    const root = scrollRootRef?.current;
    if (!root) return;
    // The parent's DOM ref can attach after child layout effects on first mount.
    setRevision(value => value + 1);
    let frame = 0;
    const clearAnchor = () => { readingAnchor.current = null; };
    const onScroll = () => {
      if (root.scrollHeight - root.scrollTop - root.clientHeight <= 48) clearAnchor();
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateViewport(); });
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    for (const event of ["wheel", "touchmove", "pointerdown", "keydown"]) root.addEventListener(event, clearAnchor, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      for (const event of ["wheel", "touchmove", "pointerdown", "keydown"]) root.removeEventListener(event, clearAnchor);
      cancelAnimationFrame(frame);
    };
  }, [scrollRootRef, updateViewport]);

  useLayoutEffect(() => {
    const root = scrollRootRef?.current;
    const node = list.current;
    if (!root || !node) return;
    const measure = () => {
      const state = current.current;
      const localTop = root.scrollTop - listOffset();
      const anchor = (readingAnchor.current ? state.indices.get(readingAnchor.current) : undefined) ?? rowAt(state.offsets, localTop);
      const pinned = root.scrollHeight - root.scrollTop - root.clientHeight <= 48;
      let correction = 0;
      let changed = false;
      const width = node.clientWidth;
      if (width > 0 && cache.width !== width) {
        cache.width = width;
        cache.heights.clear();
        changed = true;
      }
      for (const row of node.querySelectorAll<HTMLElement>(":scope > [data-virtual-row]")) {
        const id = row.dataset.virtualRow!;
        const index = state.indices.get(id);
        const height = row.getBoundingClientRect().height;
        if (index === undefined || height <= 0) continue;
        const oldHeight = cache.heights.get(id) ?? estimateEntryHeight(state.entries[index]) + GAP;
        if (Math.abs(oldHeight - height) < 1 && cache.heights.has(id)) continue;
        cache.heights.set(id, height);
        if (index < anchor) correction += height - oldHeight;
        changed = true;
      }
      if (changed) {
        // Bound cached geometry in batches as well; preserve the loaded rows.
        if (cache.heights.size > 4096) {
          for (const id of cache.heights.keys()) {
            if (!state.indices.has(id)) cache.heights.delete(id);
            if (cache.heights.size <= 3072) break;
          }
        }
        // Parent layout effects restore history anchors in this same commit.
        // Publish measured offsets before they read them, even though React's
        // rendered spacer catches up in the following synchronous commit.
        let total = 0;
        const offsets = state.entries.map(entry => {
          const top = total;
          total += cache.heights.get(entry.id) ?? estimateEntryHeight(entry) + GAP;
          return top;
        });
        current.current = { ...state, offsets, total };
        if (!pinned && correction) root.scrollTop += correction;
        setRevision(value => value + 1);
      }
      updateViewport();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    for (const row of node.children) observer?.observe(row);
    return () => observer?.disconnect();
  }, [start, end, layout, cache, scrollRootRef, listOffset, updateViewport]);

  const rows = renderRows(entries.slice(start, end), start);
  if (!scrollRootRef) return <div className="flex flex-col gap-5">{rows}</div>;
  return <div ref={list} data-virtual-timeline style={{ position: "relative", height: layout.total, overflowAnchor: "none" }}>
    {rows.map((row, index) => <div key={entries[start + index].id}
      data-virtual-row={entries[start + index].id}
      style={{ position: "absolute", top: layout.offsets[start + index], left: 0, right: 0, paddingBottom: GAP, display: "flow-root" }}>
      {row}
    </div>)}
  </div>;
}
