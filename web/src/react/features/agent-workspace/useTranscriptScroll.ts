import { useLayoutEffect, type RefObject } from "react";

const positions = new Map<
  string,
  { top: number; pinned: boolean; reading: boolean }
>();

/** Follow streamed growth only while pinned; manual history browsing is a separate signal. */
export function useTranscriptScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  sessionId?: string,
  onReadingHistoryChange?: (reading: boolean) => void,
  ready = true,
) {
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !sessionId || !ready) return;
    const content = element.firstElementChild;
    const saved = positions.get(sessionId);
    let pinned = saved?.pinned ?? true;
    let readingHistory = saved?.reading ?? false;
    let manualUntil = 0;
    let pointerDown = false;
    let lastTop = element.scrollTop;
    const publish = (reading: boolean) => {
      if (readingHistory === reading) return;
      readingHistory = reading;
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
      pinned = false;
      publish(true);
    };
    const handleDisclosureKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") inspectDisclosure(event);
    };
    const handleScroll = () => {
      const top = element.scrollTop;
      const distance = element.scrollHeight - top - element.clientHeight;
      pinned = distance <= 48;
      if (distance <= 32) publish(false);
      else if (
        distance >= 96 &&
        top < lastTop - 1 &&
        (pointerDown || performance.now() <= manualUntil)
      )
        publish(true);
      lastTop = top;
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
    element.scrollTop = pinned ? element.scrollHeight : saved!.top;
    lastTop = element.scrollTop;
    onReadingHistoryChange?.(readingHistory);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (pinned) {
              element.scrollTop = element.scrollHeight;
              lastTop = element.scrollTop;
            }
          });
    if (observer && content) observer.observe(content);
    return () => {
      positions.delete(sessionId);
      positions.set(sessionId, {
        top: lastTop,
        pinned,
        reading: readingHistory,
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
}
