import { useLayoutEffect, type RefObject } from "react";

/** The stylesheet reads this on the transcript host; keep both sides in sync. */
export const SIDE_CHAT_COMPOSER_INSET = "--side-chat-composer-inset";

/**
 * Publishes how much of the transcript host the floating composer covers.
 *
 * The side chat reuses the shared footer composer, which is absolutely
 * positioned (`.agent-session-composer--footer`), so its scrollport still ends
 * at the panel edge and the newest entries sit behind the input once the
 * reader pins to the bottom. The covered height lands on the host as a CSS
 * variable that the transcript consumes as bottom padding — the same contract
 * `--agent-command-rail-height` provides for the main conversation.
 */
export function useComposerOverlayInset(
  hostRef: RefObject<HTMLDivElement | null>,
  composerRef: RefObject<HTMLDivElement | null>,
): void {
  useLayoutEffect(() => {
    const host = hostRef.current;
    // The wrapper keeps its place in the column; the composer inside it is the
    // out-of-flow box whose top edge is what the transcript must clear.
    const composer = composerRef.current?.firstElementChild;
    if (!host || !(composer instanceof HTMLElement)) return;
    const apply = () => {
      if (!host.isConnected || host.clientHeight <= 0) return;
      const covered =
        host.getBoundingClientRect().bottom -
        composer.getBoundingClientRect().top;
      // A composer taller than the host (collapsed panel, long attachment
      // list) must not push the transcript past its own viewport.
      const inset = Math.max(0, Math.min(Math.ceil(covered), host.clientHeight));
      host.style.setProperty(SIDE_CHAT_COMPOSER_INSET, `${inset}px`);
    };
    apply();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(composer);
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      host.style.removeProperty(SIDE_CHAT_COMPOSER_INSET);
    };
  }, [composerRef, hostRef]);
}
