import { useLayoutEffect, useState, type RefObject } from "react";

/** Prepare the mounted viewport without hiding it from layout/IntersectionObserver. */
export function useTranscriptReveal(
  root: RefObject<HTMLDivElement | null>,
  sessionId: string | null,
  ready: boolean,
  active: boolean,
) {
  const [revealed, setRevealed] = useState<string | null>(null);
  useLayoutEffect(() => {
    setRevealed(null);
  }, [sessionId]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !sessionId || !ready || !active || revealed === sessionId) return;
    let frame = 0;
    let stable = 0;
    let previous = "";
    const check = () => {
      const pending = element.querySelector('[data-transcript-pending="true"]');
      const images = Array.from(element.querySelectorAll("img"));
      const videos = Array.from(element.querySelectorAll("video"));
      const resourcesReady = !pending && images.every(image => image.complete) &&
        videos.every(video => video.readyState >= 1 || video.error !== null);
      const geometry = `${element.scrollHeight}:${element.clientHeight}:${element.scrollTop}`;
      stable = resourcesReady && geometry === previous ? stable + 1 : 0;
      previous = geometry;
      // Allow lazy rows, disclosure effects and scroll restoration to commit first.
      if (stable >= 3) {
        setRevealed(sessionId);
        return;
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [root, sessionId, ready, active, revealed]);
  return revealed === sessionId && sessionId !== null;
}
