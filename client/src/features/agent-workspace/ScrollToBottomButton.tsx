import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowDown } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";

/**
 * How far above the composer the button floats. The transcript viewport ends
 * where the command rail begins, and the rail publishes its own measured
 * height, so the button tracks a resizing composer (queue strip, attachments,
 * approval bar) the same way the transcript padding does. The extra 1rem
 * clears the file-change island that docks directly above the input pill.
 */
const BOTTOM_OFFSET = "calc(var(--agent-command-rail-height, 7.25rem) + 1rem)";

/** The reader has left the bottom tenth of the scrollable range. */
const BOTTOM_RATIO = 0.1;

/**
 * A short transcript cannot be read as "scrolled away": without a floor, a
 * couple of pixels of slack would pop the button in on a nearly empty chat.
 */
const MIN_AWAY_PX = 24;

export function isAwayFromBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  const range = scrollHeight - clientHeight;
  if (range <= 0) return false;
  return range - scrollTop > Math.max(MIN_AWAY_PX, range * BOTTOM_RATIO);
}

/**
 * Jump-to-latest affordance for the conversation stream.
 *
 * It appears on its own as soon as the reader scrolls out of the bottom tenth
 * of the transcript and disappears again once they are back at the live edge,
 * so long agent runs never strand the reader in history without a way back.
 */
export function ScrollToBottomButton({
  scrollRef,
  onScrollToBottom,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScrollToBottom: () => void;
}) {
  const { locale } = useLocale();
  const [visible, setVisible] = useState(false);
  // Scroll events fire far faster than the boolean changes; only re-render on
  // an actual edge transition.
  const visibleRef = useRef(false);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      const next = isAwayFromBottom(
        element.scrollTop,
        element.clientHeight,
        element.scrollHeight,
      );
      if (next === visibleRef.current) return;
      visibleRef.current = next;
      setVisible(next);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    // Streamed turns and lazy-loaded entries grow the content without a scroll
    // event, so the verdict has to be re-read after layout settles.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const content = element.firstElementChild;
    if (observer && content) observer.observe(content);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [scrollRef]);

  const label = locale === "zh" ? "滚动到底部" : "Scroll to bottom";

  return (
    <button
      type="button"
      className="session-scroll-to-bottom"
      data-visible={visible ? "true" : "false"}
      style={{ bottom: BOTTOM_OFFSET }}
      // A hidden control must stay out of both the pointer and the tab order.
      aria-hidden={visible ? undefined : "true"}
      tabIndex={visible ? 0 : -1}
      aria-label={label}
      title={label}
      onClick={onScrollToBottom}
    >
      <ArrowDown size={16} strokeWidth={2} aria-hidden />
    </button>
  );
}
