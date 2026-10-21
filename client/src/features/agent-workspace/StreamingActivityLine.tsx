import { useLayoutEffect, useRef } from "react";
import { useStreamingText } from "./useStreamingText";

/**
 * Fixed single-line readout for a live turn.
 *
 * The newest thought or call streams into a stable one-line box instead of
 * wrapping into a paragraph. Once the text is wider than the box the line is
 * pushed left so the freshest characters stay inside the viewport: no marquee,
 * no loop, no layout jump while the turn keeps growing.
 */
export function StreamingActivityLine({
  text,
  streaming = true,
}: {
  text: string;
  /** Reveal new characters as they arrive; history renders the line as-is. */
  streaming?: boolean;
}) {
  // Reuse the transcript's reveal pacing so bursts do not teleport the line.
  const visible = useStreamingText(text, streaming, false);
  const viewport = useRef<HTMLSpanElement | null>(null);
  const track = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const view = viewport.current;
    const line = track.current;
    if (!view || !line) return;
    const follow = () => {
      const overflow = line.scrollWidth - view.clientWidth;
      line.style.transform = overflow > 0 ? `translateX(${-overflow}px)` : "";
      // The fade only hides clipped text; a line that still fits stays crisp.
      view.dataset.overflow = overflow > 0 ? "true" : "false";
    };
    follow();
    // Layout is the scroll position here: a resize must re-pin the tail.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(follow);
    observer.observe(view);
    observer.observe(line);
    return () => observer.disconnect();
  });

  return (
    <span className="session-process-line" data-streaming={streaming || undefined} ref={viewport} aria-hidden="true">
      <span className="session-process-line-track" ref={track}>
        {visible}
      </span>
    </span>
  );
}
