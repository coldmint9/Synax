import { useLayoutEffect, useState, type RefObject } from "react";

/** Reveal in the same paint as scroll restoration; background work never hides a readable page. */
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
    // Media owns its own placeholder. Waiting for it (or for a live transcript
    // to stop growing) adds a visible loading cycle on every cached switch.
    setRevealed(sessionId);
  }, [root, sessionId, ready, active, revealed]);
  return revealed === sessionId && sessionId !== null;
}
