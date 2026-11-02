import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { TRANSCRIPT_ENTRY_READY_EVENT } from "./TimelineLazyEntry";

/** Entries that still reserve height because their body has not mounted yet. */
const PENDING_SELECTOR = "[data-entry-pending='true']";

function pendingEntryIds(element: HTMLElement): Set<string> {
  const ids = new Set<string>();
  element.querySelectorAll<HTMLElement>(PENDING_SELECTOR).forEach((node) => {
    const entryId = node.dataset.sessionEntry;
    if (entryId) ids.add(entryId);
  });
  return ids;
}

/**
 * True while any entry in the rendered timeline is still a height reservation
 * instead of a real body. A session or workspace switch uses this so its
 * transition never resolves onto a half-rendered list of tool-call records:
 * the rows near the viewport, including the preload margin, must be mounted.
 *
 * Only entries currently in the DOM are awaited. The transcript virtualizes,
 * so rows outside the rendered window do not hold the transition open.
 */
export function useTranscriptRenderPending(
  root: RefObject<HTMLElement | null>,
  switchKey: string | null,
  enabled = true,
): boolean {
  const previousKey = useRef(switchKey);
  const [pending, setPending] = useState(false);

  useLayoutEffect(() => {
    const switched = previousKey.current !== switchKey;
    previousKey.current = switchKey;
    const element = root.current;
    if (!enabled || !switched || !switchKey || !element) return;
    const waiting = pendingEntryIds(element);
    if (waiting.size === 0) {
      setPending(false);
      return;
    }
    setPending(true);
    const handleReady = (event: Event) => {
      const entryId =
        event.target instanceof HTMLElement
          ? event.target.dataset.sessionEntry
          : undefined;
      if (!entryId || !waiting.delete(entryId)) return;
      if (waiting.size === 0) setPending(false);
    };
    element.addEventListener(TRANSCRIPT_ENTRY_READY_EVENT, handleReady);
    // The virtual window refines its first viewport over the next frames, so
    // reconcile the set once before treating it as final.
    const reconcile = () => {
      waiting.forEach((entryId) => {
        const node = element.querySelector<HTMLElement>(
          `[data-session-entry="${entryId}"]`,
        );
        if (!node || !node.hasAttribute("data-entry-pending"))
          waiting.delete(entryId);
      });
      pendingEntryIds(element).forEach((entryId) => waiting.add(entryId));
      if (waiting.size === 0) setPending(false);
    };
    const frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => requestAnimationFrame(reconcile))
        : window.setTimeout(reconcile, 32);
    return () => {
      element.removeEventListener(TRANSCRIPT_ENTRY_READY_EVENT, handleReady);
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
    };
  }, [root, switchKey, enabled]);

  return enabled ? pending : false;
}
