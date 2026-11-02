import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { copyTextToClipboard } from "../../adapters/electron/clipboard";

/** How long the confirmation pill stays on screen once the copy lands. */
const HOLD_MS = 2000;
/** Fade-out window; keeps the unmount in step with selectionCopyPill.css. */
const FADE_MS = 160;
/** selectionchange streams during a drag, so wait for the pointer to settle. */
const SETTLE_MS = 260;
/** A single character is almost always a click that landed on text. */
const MIN_CHARS = 2;
/** mouseup and the trailing selectionchange report the same finished drag. */
const DEDUPE_MS = 400;
/** Pill height, only used to decide whether it fits below the last line. */
const PILL_HEIGHT = 28;
const GAP = 8;
/** Same areas the native context menu already leaves alone. */
const EDITABLE_SELECTOR =
  'input, textarea, [contenteditable=""], [contenteditable="true"]';

export interface SelectionCopyPillState {
  top: number;
  left: number;
  placement: "below" | "above";
  visible: boolean;
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

/** Both ends of the selection must be transcript text, never a text field. */
function isTranscriptSelection(scope: Element, selection: Selection): boolean {
  for (const node of [selection.anchorNode, selection.focusNode]) {
    const element = elementOf(node);
    if (!element || !scope.contains(element)) return false;
    if (element.closest(EDITABLE_SELECTOR)) return false;
  }
  return true;
}

function rangeRect(range: Range): DOMRect | null {
  try {
    const box = range.getBoundingClientRect();
    return box.width || box.height || box.top || box.left ? box : null;
  } catch {
    return null;
  }
}

function lineRects(range: Range): DOMRect[] {
  try {
    if (typeof range.getClientRects !== "function") return [];
    return Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
  } catch {
    return [];
  }
}

/**
 * Places the pill under the last line of the selection, in the coordinate
 * space of the transcript viewport. A selection that reaches the viewport's
 * bottom edge flips the pill above its first visible line instead of pushing it
 * out of the transcript.
 */
function resolveAnchor(
  range: Range,
  host: HTMLElement,
): Omit<SelectionCopyPillState, "visible"> | null {
  const hostRect = host.getBoundingClientRect();
  const lines = lineRects(range);
  const visible = lines.filter((rect) => rect.bottom <= hostRect.bottom - GAP);
  const anchor =
    visible[visible.length - 1] ?? lines[lines.length - 1] ?? rangeRect(range);
  if (!anchor) return null;

  const below = anchor.bottom - hostRect.top + GAP;
  const limit = (host.clientHeight || hostRect.height) - GAP;
  const placement = below + PILL_HEIGHT <= limit ? "below" : "above";
  const top =
    placement === "below"
      ? below
      : Math.max(GAP, anchor.top - hostRect.top - PILL_HEIGHT - GAP);

  return {
    top,
    left: anchor.left + anchor.width / 2 - hostRect.left,
    placement,
  };
}

/**
 * Copies whatever the reader finishes selecting inside the transcript and
 * publishes the anchor for a short confirmation pill.
 *
 * The copy is the point of the feature, so every guard here exists to keep it
 * from firing when it would be wrong: selections outside the transcript, text
 * fields, single characters and copy failures all stay silent. The pill keeps
 * the range it was measured from so scrolling re-anchors it instead of leaving
 * it behind.
 */
export function useSelectionAutoCopy({
  hostRef,
  scopeRef,
  scrollRef,
}: {
  hostRef: RefObject<HTMLElement | null>;
  scopeRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
}): SelectionCopyPillState | null {
  const [pill, setPill] = useState<SelectionCopyPillState | null>(null);
  const rangeRef = useRef<Range | null>(null);
  const holdTimer = useRef<number | null>(null);
  const fadeTimer = useRef<number | null>(null);
  const lastHit = useRef({ text: "", at: 0 });

  const clearTimers = useCallback(() => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
    holdTimer.current = null;
    fadeTimer.current = null;
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    rangeRef.current = null;
    setPill(null);
  }, [clearTimers]);

  const show = useCallback(
    (anchor: Omit<SelectionCopyPillState, "visible">) => {
      clearTimers();
      setPill({ ...anchor, visible: true });
      holdTimer.current = window.setTimeout(() => {
        setPill((current) =>
          current ? { ...current, visible: false } : current,
        );
        fadeTimer.current = window.setTimeout(() => {
          rangeRef.current = null;
          setPill(null);
        }, FADE_MS);
      }, HOLD_MS);
    },
    [clearTimers],
  );

  useEffect(() => {
    let settleTimer: number | null = null;

    const handleSelection = async () => {
      const host = hostRef.current;
      const scope = scopeRef.current;
      if (!host || !scope) return;

      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      if (!selection || !text) {
        lastHit.current = { text: "", at: 0 };
        dismiss();
        return;
      }

      const now = Date.now();
      if (text === lastHit.current.text && now - lastHit.current.at < DEDUPE_MS)
        return;
      lastHit.current = { text, at: now };

      if (text.length < MIN_CHARS || selection.rangeCount === 0) {
        dismiss();
        return;
      }

      if (!isTranscriptSelection(scope, selection)) {
        dismiss();
        return;
      }

      const range = selection.getRangeAt(0).cloneRange();
      const copied = await copyTextToClipboard(text);
      // A new drag may have started while the write was in flight; its own
      // handler paints the next pill, so this result must not overwrite it.
      if (!copied) {
        dismiss();
        return;
      }
      if ((window.getSelection()?.toString().trim() ?? "") !== text) return;

      const anchor = resolveAnchor(range, host);
      if (!anchor) return;
      rangeRef.current = range;
      show(anchor);
    };

    const onSelectionChange = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        void handleSelection();
      }, SETTLE_MS);
    };

    // The pointer path copies as soon as the drag ends; the keyboard path has
    // only selectionchange to go on and waits for the reader to stop moving.
    // Listening on the document keeps the immediate path working while the
    // transcript content is still mounting.
    const onPointerUp = (event: MouseEvent) => {
      const scope = scopeRef.current;
      const target = event.target;
      if (!scope || !(target instanceof Node) || !scope.contains(target)) return;
      void handleSelection();
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mouseup", onPointerUp);
    return () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mouseup", onPointerUp);
    };
  }, [dismiss, hostRef, scopeRef, show]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const follow = () => {
      frame = 0;
      const host = hostRef.current;
      const range = rangeRef.current;
      if (!range) return;
      if (!host || !range.startContainer.isConnected) {
        dismiss();
        return;
      }
      const anchor = resolveAnchor(range, host);
      if (!anchor) {
        dismiss();
        return;
      }
      setPill((current) => {
        if (!current) return current;
        if (current.top === anchor.top && current.left === anchor.left)
          return current;
        return { ...current, ...anchor };
      });
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(follow);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [dismiss, hostRef, scrollRef]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  return pill;
}
