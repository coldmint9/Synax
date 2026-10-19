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
}

/** Prefetch within one viewport of the start, preserving the reader's position. */
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
  const [error, setError] = useState("");
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
    setError("");
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
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
    }
    pending.current = null;
  }, [firstId, page?.olderCursor, page?.epoch, scrollRef, sessionId]);

  const loadOlder = useCallback(async (manual = false) => {
    const element = scrollRef.current;
    if (!active || !sessionId || !element || element.clientHeight === 0 || !page?.olderCursor || busy.current ||
        useAgentSessionStore.getState().selectedSessionId !== sessionId) return;
    if (!manual && blockedCursor.current === page.olderCursor) return;
    blockedCursor.current = null;
    busy.current = true;
    const token = ++generation.current;
    const cursor = page.olderCursor;
    pending.current = {
      sessionId, cursor, firstId, epoch: page.epoch,
      top: element.scrollTop, height: element.scrollHeight,
    };
    setLoading(true);
    setError("");
    try {
      await useAgentSessionStore.getState().loadOlderHistory();
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
      }
    }
  }, [active, firstId, page?.olderCursor, page?.epoch, scrollRef, sessionId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!active || !element || !sessionId || !page?.olderCursor) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      if (element.clientHeight === 0) return;
      const maxTop = element.scrollHeight - element.clientHeight;
      const nearStart = element.scrollTop <= Math.max(96, element.clientHeight);
      // Opening a short but scrollable transcript should still show the latest
      // page. Prefetch once the reader leaves the bottom, or fill an empty viewport.
      if (maxTop <= 1 || (nearStart && (element.scrollTop <= 1 || maxTop - element.scrollTop > 48)))
        void loadOlder();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    const onScroll = () => {
      if (pending.current) {
        pending.current.top = element.scrollTop;
        pending.current.height = element.scrollHeight;
      }
      schedule();
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    // Recheck after each request settles, even if its cursor was already
    // published while busy. Lazy rows and viewport resizes can change the edge.
    schedule();
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active, loadOlder, loading, page?.olderCursor, scrollRef, sessionId]);

  return { loading, error, retry: () => loadOlder(true) };
}
