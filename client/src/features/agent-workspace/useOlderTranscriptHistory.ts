import { setSessionHistoryReading } from "./state/sessionTailWindow";
import { anchorVirtualEntry, virtualEntryOffset } from "./TimelineVirtualWindow";
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject,
} from "react";
import { useAgentSessionStore } from "./state/agentSessionStore";

interface ScrollAnchor {
  sessionId: string;
  cursor: string;
  firstId?: string;
  epoch: number;
  top: number;
  height: number;
  entryId?: string;
  entryTop?: number;
}

const BUFFER_SCREENS = 2;
/** Frame ceiling for waiting on a prepended page to stop moving the layout. */
const SETTLE_MAX_FRAMES = 24;

/**
 * Resolve once the prepended page is genuinely in the DOM: its rows have
 * mounted (no height reservations left) and the scroll height held still for
 * two frames. A request resolving is not the same event as the page landing —
 * reporting the page as loaded while rows are still mounting is what makes the
 * indicator flicker.
 */
function whenPageSettled(
  element: HTMLElement,
  headChanged: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const before = element.scrollHeight;
    let frames = 0;
    let stable = 0;
    let height = before;
    const step = () => {
      frames += 1;
      const next = element.scrollHeight;
      const pending = element.querySelector("[data-entry-pending='true']");
      stable = !pending && next === height ? stable + 1 : 0;
      height = next;
      const arrived = next !== before || headChanged();
      if ((arrived && stable >= 2) || frames >= SETTLE_MAX_FRAMES) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Keep two screens of history warm, preserving the reader's position on prepend. */
export function useOlderTranscriptHistory(
  scrollRef: RefObject<HTMLDivElement | null>,
  sessionId: string | null,
  active: boolean,
) {
  const page = useAgentSessionStore((state) =>
    sessionId ? state.sessionDetailCache[sessionId]?.historyWindow : undefined,
  );
  const firstId = useAgentSessionStore((state) =>
    state.selectedSessionId === sessionId ? state.messages[0]?.id : undefined,
  );
  const [loading, setLoading] = useState(false);
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<{ sessionId: string; epoch: number } | null>(null);
  const pending = useRef<ScrollAnchor | null>(null);
  const busy = useRef(false);
  const blockedCursor = useRef<string | null>(null);
  const generation = useRef(0);

  useLayoutEffect(() => {
    generation.current++;
    busy.current = false;
    pending.current = null;
    blockedCursor.current = null;
    setLoading(false);
    setSettling(false);
    setError("");
    setPrepared(null);
    return () => {
      generation.current++;
      pending.current = null;
    };
  }, [sessionId, page?.epoch]);

  useLayoutEffect(() => {
    const anchor = pending.current;
    if (!anchor || anchor.sessionId !== sessionId) return;
    if (anchor.epoch !== page?.epoch) {
      pending.current = null;
      return;
    }
    if (anchor.firstId === firstId && anchor.cursor === page?.olderCursor) return;
    const element = scrollRef.current;
    if (element) {
      const anchored = anchor.entryId && anchor.entryTop !== undefined &&
        anchorVirtualEntry(element, anchor.entryId, anchor.entryTop);
      if (!anchored) element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
    }
    pending.current = null;
  }, [firstId, page?.olderCursor, page?.epoch, scrollRef, sessionId]);

  const loadOlder = useCallback(async (manual = false, prefill = false) => {
    const element = scrollRef.current;
    if (!active || !sessionId || !element || element.clientHeight === 0 || !page?.olderCursor || busy.current ||
        useAgentSessionStore.getState().selectedSessionId !== sessionId) return;
    if (!manual && blockedCursor.current === page.olderCursor) return;
    blockedCursor.current = null;
    if (!prefill) {
      setSessionHistoryReading(sessionId, true);
      element.dispatchEvent(new Event("transcript-history-reading"));
    }
    busy.current = true;
    const token = ++generation.current;
    const cursor = page.olderCursor;
    pending.current = {
      sessionId, cursor, firstId, epoch: page.epoch,
      top: element.scrollTop, height: element.scrollHeight,
    };
    const rootTop = element.getBoundingClientRect().top;
    const visible = Array.from(element.querySelectorAll<HTMLElement>("[data-session-entry]"))
      .find(row => row.getBoundingClientRect().bottom > rootTop);
    if (visible?.dataset.sessionEntry) {
      const offset = virtualEntryOffset(element, visible.dataset.sessionEntry);
      if (offset !== undefined) {
        pending.current.entryId = visible.dataset.sessionEntry;
        pending.current.entryTop = offset - element.scrollTop;
      }
    }
    setLoading(true);
    setError("");
    try {
      await useAgentSessionStore.getState().loadOlderHistory(prefill ? { retainViewport: true } : undefined);
    } catch (cause) {
      if (generation.current === token) {
        pending.current = null;
        blockedCursor.current = cursor;
        setError(String(cause));
      }
    } finally {
      if (generation.current === token) {
        const state = useAgentSessionStore.getState();
        // A discarded/no-progress page must not become an automatic request loop.
        if (state.sessionDetailCache[sessionId]?.historyWindow?.olderCursor === cursor)
          blockedCursor.current = cursor;
        if (pending.current?.sessionId === sessionId &&
            pending.current.firstId === state.messages[0]?.id &&
            pending.current.cursor === state.sessionDetailCache[sessionId]?.historyWindow?.olderCursor)
          pending.current = null;
        busy.current = false;
        setLoading(false);
        // Hold the indicator through the mount that follows the request, so it
        // never clears on a half-rendered page and never re-appears a frame later.
        if (element.isConnected && state.messages[0]?.id !== firstId) {
          setSettling(true);
          void whenPageSettled(
            element,
            () => useAgentSessionStore.getState().messages[0]?.id !== firstId,
          ).then(() => {
            if (generation.current === token) setSettling(false);
          });
        } else {
          setSettling(false);
        }
      }
    }
  }, [active, firstId, page?.olderCursor, page?.epoch, scrollRef, sessionId]);

  // A page can collapse into a single work-log row. Measure the rendered height
  // rather than assuming a fixed message count fills a viewport. Recheck after
  // every page and resize, without waiting for another wheel/touch gesture.
  useEffect(() => {
    const element = scrollRef.current;
    if (!active || !element || !sessionId || !page || loading) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      if (!element.clientHeight || busy.current) return;
      const needsBuffer = element.scrollHeight - element.clientHeight < element.clientHeight * BUFFER_SCREENS;
      if (needsBuffer && page.olderCursor && blockedCursor.current !== page.olderCursor) {
        void loadOlder(false, true);
      } else {
        setPrepared(previous => previous?.sessionId === sessionId && previous.epoch === page.epoch
          ? previous : { sessionId, epoch: page.epoch });
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    schedule();
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [active, loading, loadOlder, page, scrollRef, sessionId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!active || !element || !sessionId || !page?.olderCursor) return;
    let frame = 0;
    let upwardIntent = false;
    let lastTop = element.scrollTop;
    let touchY = 0;
    let dragging = false;
    const check = () => {
      frame = 0;
      if (!upwardIntent || element.clientHeight === 0) return;
      upwardIntent = false;
      if (element.scrollTop <= Math.max(96, element.clientHeight * BUFFER_SCREENS)) void loadOlder();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    const onScroll = () => {
      if (pending.current) {
        if (pending.current.entryTop !== undefined)
          pending.current.entryTop -= element.scrollTop - pending.current.top;
        pending.current.top = element.scrollTop;
        pending.current.height = element.scrollHeight;
      }
      if (dragging && element.scrollTop < lastTop) upwardIntent = true;
      lastTop = element.scrollTop;
      if (upwardIntent) schedule();
    };
    const onWheel = (event: WheelEvent) => {
      upwardIntent = event.deltaY < 0;
      if (upwardIntent) schedule();
    };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) { upwardIntent = true; schedule(); }
    };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      upwardIntent = y > touchY;
      touchY = y;
      if (upwardIntent) schedule();
    };
    const onPointerDown = () => { dragging = true; };
    const onPointerUp = () => { dragging = false; };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("keydown", onKey);
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: true });
    element.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      cancelAnimationFrame(frame);
    };
  }, [active, loadOlder, page?.olderCursor, scrollRef, sessionId]);

  return {
    loading, settling, error, hasEarlier: Boolean(page?.olderCursor),
    retry: () => loadOlder(true),
    ready: !page?.olderCursor || (prepared?.sessionId === sessionId && prepared.epoch === page?.epoch),
  };
}
