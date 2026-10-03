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

/** Load older pages only at the top, preserving the visible row on prepend. */
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
  const generation = useRef(0);

  useLayoutEffect(() => {
    generation.current++;
    busy.current = false;
    pending.current = null;
    setLoading(false);
    setError("");
  }, [sessionId]);

  useLayoutEffect(() => {
    const anchor = pending.current;
    if (!anchor || anchor.sessionId !== sessionId) return;
    if (anchor.epoch !== page?.epoch) {
      pending.current = null;
      return;
    }
    if (anchor.firstId === firstId && anchor.cursor === page?.olderCursor) return;
    const element = scrollRef.current;
    if (element && anchor.firstId !== firstId && element.scrollTop <= 160) {
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
    }
    pending.current = null;
  }, [firstId, page?.olderCursor, scrollRef, sessionId]);

  const loadOlder = useCallback(async () => {
    const element = scrollRef.current;
    if (!active || !sessionId || !element || !page?.olderCursor || busy.current ||
        useAgentSessionStore.getState().selectedSessionId !== sessionId) return;
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
      pending.current = null;
      if (generation.current === token)
        setError(String(cause));
    } finally {
      if (generation.current === token) {
        const state = useAgentSessionStore.getState();
        if (pending.current?.sessionId === sessionId &&
            pending.current.firstId === state.messages[0]?.id &&
            pending.current.cursor === state.sessionDetailCache[sessionId]?.historyWindow?.olderCursor)
          pending.current = null;
        busy.current = false;
        setLoading(false);
      }
    }
  }, [active, firstId, page?.olderCursor, scrollRef, sessionId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!active || !element || !sessionId || !page?.olderCursor) return;
    const onScroll = () => {
      if (element.scrollTop <= 96) void loadOlder();
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    // A short page may not scroll; keep fetching while the reader is at the top.
    if (element.scrollTop <= 96 || element.scrollHeight <= element.clientHeight)
      void loadOlder();
    return () => element.removeEventListener("scroll", onScroll);
  }, [active, loadOlder, page?.olderCursor, scrollRef, sessionId]);

  return { loading, error, retry: loadOlder };
}
