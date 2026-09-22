import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

const positions = new Map<
  string,
  { top: number; pinned: boolean; reading: boolean }
>();

export interface TranscriptScrollController {
  /**
   * Scroll the transcript to the bottom. With `force` (default) the bottom pin
   * is re-established first, so entry points like "message sent", "first AI
   * response" and "run finished" always land on the latest content even when
   * the user had scrolled away.
   */
  scrollToBottom: (force?: boolean) => void;
}

/** Follow streamed growth only while pinned; manual history browsing is a separate signal. */
export function useTranscriptScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  sessionId?: string,
  onReadingHistoryChange?: (reading: boolean) => void,
  ready = true,
): TranscriptScrollController {
  const pinnedRef = useRef(true);
  const readingRef = useRef(false);
  const lastTopRef = useRef(0);

  const scrollToBottom = useCallback(
    (force = true) => {
      const element = scrollRef.current;
      if (!element) return;
      if (force) {
        pinnedRef.current = true;
        if (readingRef.current) {
          readingRef.current = false;
          onReadingHistoryChange?.(false);
        }
      } else if (!pinnedRef.current) {
        return;
      }
      element.scrollTop = element.scrollHeight;
      lastTopRef.current = element.scrollTop;
    },
    [onReadingHistoryChange, scrollRef],
  );

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !sessionId || !ready) return;
    const content = element.firstElementChild;
    const saved = positions.get(sessionId);
    pinnedRef.current = saved?.pinned ?? true;
    readingRef.current = saved?.reading ?? false;
    let manualUntil = 0;
    let pointerDown = false;
    lastTopRef.current = element.scrollTop;
    const publish = (reading: boolean) => {
      if (readingRef.current === reading) return;
      readingRef.current = reading;
      onReadingHistoryChange?.(reading);
    };
    const markManual = () => {
      manualUntil = performance.now() + 1000;
    };
    const handlePointerDown = () => {
      pointerDown = true;
      markManual();
    };
    const handlePointerUp = () => {
      pointerDown = false;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      )
        markManual();
    };
    const inspectDisclosure = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest("summary, [aria-expanded]")) return;
      // Expanding a plan or an answer is reading, not new streamed output.
      // Release the bottom pin before ResizeObserver sees the expanded card.
      pinnedRef.current = false;
      publish(true);
    };
    const handleDisclosureKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") inspectDisclosure(event);
    };
    const handleScroll = () => {
      const top = element.scrollTop;
      const distance = element.scrollHeight - top - element.clientHeight;
      pinnedRef.current = distance <= 48;
      if (distance <= 32) publish(false);
      else if (
        distance >= 96 &&
        top < lastTopRef.current - 1 &&
        (pointerDown || performance.now() <= manualUntil)
      )
        publish(true);
      lastTopRef.current = top;
    };
    element.addEventListener("click", inspectDisclosure, true);
    element.addEventListener("keydown", handleDisclosureKey, true);
    element.addEventListener("scroll", handleScroll, { passive: true });
    element.addEventListener("wheel", markManual, { passive: true });
    element.addEventListener("touchmove", markManual, { passive: true });
    element.addEventListener("pointerdown", handlePointerDown);
    element.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    element.scrollTop = pinnedRef.current ? element.scrollHeight : saved!.top;
    lastTopRef.current = element.scrollTop;
    onReadingHistoryChange?.(readingRef.current);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (pinnedRef.current) {
              element.scrollTop = element.scrollHeight;
              lastTopRef.current = element.scrollTop;
            }
          });
    if (observer && content) observer.observe(content);
    return () => {
      positions.delete(sessionId);
      positions.set(sessionId, {
        top: lastTopRef.current,
        pinned: pinnedRef.current,
        reading: readingRef.current,
      });
      if (positions.size > 32) positions.delete(positions.keys().next().value!);
      element.removeEventListener("click", inspectDisclosure, true);
      element.removeEventListener("keydown", handleDisclosureKey, true);
      element.removeEventListener("scroll", handleScroll);
      element.removeEventListener("wheel", markManual);
      element.removeEventListener("touchmove", markManual);
      element.removeEventListener("pointerdown", handlePointerDown);
      element.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      observer?.disconnect();
      onReadingHistoryChange?.(false);
    };
  }, [scrollRef, sessionId, onReadingHistoryChange, ready]);

  return { scrollToBottom };
}
