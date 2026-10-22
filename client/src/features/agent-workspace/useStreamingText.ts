import { useLayoutEffect, useRef, useState } from "react";

// Smooth transport bursts without building a queue that trails the model.
export const STREAM_REVEAL_MS = 160;
const MAX_PENDING_GRAPHEMES = 512;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Presentation only: the store and token telemetry always retain the received text. */
export function useStreamingText(text: string, streaming: boolean, animateInitial = true): string {
  const [visible, setVisible] = useState(streaming && animateInitial ? "" : text);
  const current = useRef(visible);
  const target = useRef(text);
  const frame = useRef<number | null>(null);
  const advance = useRef<(now: number) => void>(() => {});
  const motion = useRef<MediaQueryList | null>(null);
  const timing = useRef({ last: 0, position: 0, speed: 0, ends: [] as number[] });

  const cancel = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const reveal = (value: string) => {
    current.current = value;
    setVisible(value);
  };
  advance.current = (now) => {
    frame.current = null;
    const state = timing.current;
    state.position += Math.max(0, now - state.last) * state.speed;
    state.last = now;
    const count = Math.min(state.ends.length, Math.floor(state.position));
    if (count > 0) reveal(target.current.slice(0, state.ends[count - 1]));
    if (count < state.ends.length)
      frame.current = requestAnimationFrame((time) => advance.current(time));
  };

  useLayoutEffect(() => {
    if (!streaming) return;
    motion.current = window.matchMedia("(prefers-reduced-motion: reduce)");
    const flush = () => {
      if (!document.hidden && !motion.current?.matches) return;
      cancel();
      reveal(target.current);
    };
    motion.current.addEventListener("change", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      cancel();
      motion.current?.removeEventListener("change", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [streaming]);

  useLayoutEffect(() => {
    target.current = text;
    if (!streaming || document.hidden || motion.current?.matches) {
      cancel();
      reveal(text);
      return;
    }
    // Retry/replacement must never reveal characters from the previous answer.
    if (!text.startsWith(current.current)) reveal("");
    let start = current.current.length;
    let ends = Array.from(segmenter.segment(text.slice(start)), ({ index, segment }) => start + index + segment.length);
    if (ends.length > MAX_PENDING_GRAPHEMES) {
      start = ends[ends.length - MAX_PENDING_GRAPHEMES - 1];
      reveal(text.slice(0, start));
      ends = ends.slice(-MAX_PENDING_GRAPHEMES);
    }
    if (ends.length <= 1) {
      cancel();
      reveal(text);
      return;
    }
    // Updating the target must not cancel a scheduled frame: fast incoming
    // packets would otherwise keep postponing the first visible character.
    timing.current = {
      last: frame.current === null ? performance.now() : timing.current.last,
      position: 0,
      speed: Math.max(0.08, ends.length / STREAM_REVEAL_MS),
      ends,
    };
    if (frame.current === null)
      frame.current = requestAnimationFrame((time) => advance.current(time));
  }, [text, streaming]);

  // Completion and replacement take effect in the same render, without an
  // extra paint containing an old retry or a half-revealed final answer.
  return !streaming ? text : text.startsWith(visible) ? visible : "";
}
