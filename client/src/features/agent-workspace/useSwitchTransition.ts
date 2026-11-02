import { useLayoutEffect, useRef, useState } from "react";

/**
 * Minimum time any switch transition is held, so a fast switch still reads as
 * a deliberate blur-in instead of a jump cut.
 */
export const SWITCH_TRANSITION_MIN_MS = 180;
/**
 * Ceiling for a transition that waits on data or rendering. A stuck request
 * must never leave a view blurred and non-interactive.
 */
export const SWITCH_TRANSITION_MAX_WAIT_MS = 2_000;

/**
 * Flags the frames after `switchKey` changes — a selected session or a
 * workspace route. The caller decides when the switch is actually ready
 * (history settled, records mounted, route resolved) and the flag stays up
 * until then.
 */
export function useSwitchTransition(
  switchKey: string | null,
  enabled = true,
  ready = true,
) {
  const previousKey = useRef(switchKey);
  const openedAt = useRef(0);
  const [masked, setMasked] = useState(false);

  useLayoutEffect(() => {
    const from = previousKey.current;
    previousKey.current = switchKey;
    // Leaving for an empty scene is not a swap worth masking.
    if (!enabled || !switchKey || from === switchKey) return;
    openedAt.current = Date.now();
    setMasked(true);
    const ceiling = window.setTimeout(
      () => setMasked(false),
      SWITCH_TRANSITION_MAX_WAIT_MS,
    );
    return () => window.clearTimeout(ceiling);
  }, [switchKey, enabled]);

  useLayoutEffect(() => {
    if (!masked || !ready) return;
    const remaining = Math.max(
      0,
      SWITCH_TRANSITION_MIN_MS - (Date.now() - openedAt.current),
    );
    const timer = window.setTimeout(() => setMasked(false), remaining);
    return () => window.clearTimeout(timer);
  }, [masked, ready, switchKey]);

  return masked && enabled;
}
