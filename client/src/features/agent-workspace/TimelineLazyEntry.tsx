import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  sessionEntryDomId,
  type ConversationTimelineEntry,
} from "./buildConversationTimeline";

/**
 * Heights measured during an earlier render, keyed by timeline entry.
 *
 * Module level on purpose: the value survives unmounts and session switches so
 * scrolling back into a transcript restores the real geometry instead of
 * re-estimating it from scratch.
 */
const measuredEntryHeights = new Map<string, number>();

/**
 * Heights of the rows currently on screen, keyed by `scope` + entry id.
 *
 * Separate from the height cache above because a fold needs the size of rows it
 * is about to remove, and those rows may have been measured under a different
 * cache key (a live row and its persisted counterpart share one id).
 */
const measuredRowsByScope = new Map<string, number>();

/**
 * How far outside the scrollport an entry is still mounted. Roughly one screen
 * of slack, so flick-scrolling does not run into empty reservations.
 */
const PRELOAD_MARGIN = "1200px 0px";
const viewportObservers = new Map<
  Element | null,
  {
    observer: IntersectionObserver;
    callbacks: Map<Element, () => void>;
  }
>();

const FALLBACK_ENTRY_HEIGHT = 180;

/** Bubbles from an entry once its deferred body is mounted and laid out. */
export const TRANSCRIPT_ENTRY_READY_EVENT = "transcript-entry-ready";

/**
 * Total height actually measured for the rows a finished round folded away.
 *
 * Used to animate the collapse into the `工作用时` row instead of snapping:
 * the caller plays a height transition from this size down to the folded row.
 * A step's rows keep the step id as a prefix (`<stepId>:content:1`), so a match
 * covers every row that step was split into, and a plain id never swallows the
 * neighbouring `<stepId>-answer` reply.
 */
export function getMeasuredFoldHeight(
  scope: string | undefined,
  stepIds: readonly string[],
  /**
   * Steps whose commentary stays outside the fold. Their reply row is rendered
   * anyway, so counting it would start the collapse too tall and shove the
   * answer down for the length of the transition.
   */
  keepsContent?: ReadonlySet<string>,
): number {
  if (!scope || stepIds.length === 0) return 0;
  const prefix = `${scope}\u0000`;
  let height = 0;
  for (const [key, value] of measuredRowsByScope) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (
      !stepIds.some((stepId) => {
        if (id === stepId) return true;
        if (!id.startsWith(`${stepId}:`)) return false;
        return !(keepsContent?.has(stepId) && id.startsWith(`${stepId}:content:`));
      })
    )
      continue;
    height += value;
  }
  return Math.round(height);
}

/**
 * Cheap height estimate derived from the entry shape. It is only used until a
 * real measurement exists, but being in the right order of magnitude is what
 * keeps the scrollbar from lurching while the transcript settles.
 */
export function estimateEntryHeight(entry: ConversationTimelineEntry): number {
  if (entry.kind === "error") return 112;
  if (entry.kind === "model_switch") return 28;
  if (entry.kind === "interaction")
    return entry.interaction.status === "pending" ? 320 : 100;
  if (entry.kind === "user") {
    return Math.min(600, 72 + Math.ceil(entry.content.length / 80) * 20);
  }

  if (entry.kind === "compaction") return 36;
  if (entry.kind === "work_log") {
    // Folded runs render as a single collapsed activity row.
    return 28;
  }

  let height = 28; // turn chrome + divider
  for (const block of entry.turn.blocks) {
    switch (block.type) {
      case "git_merge":
        height += block.superseded ? 76 : 480;
        break;
      case "media":
        height += 180;
        break;
      case "thinking":
        height += 20; // one collapsed activity line
        break;
      case "text":
        height += Math.min(720, 40 + Math.ceil(block.content.length / 80) * 20);
        break;
      case "tool_call":
        height += 46;
        break;
      case "tool_call_group":
        height += 46 + Math.max(0, block.calls.length - 1) * 34;
        break;
      case "sub_session":
        height += 76;
        break;
      case "context_compacted":
        height += 40;
        break;
    }
  }
  return height;
}

interface Props {
  entryId: string;
  cacheKey: string;
  estimate: number;
  /** Session scope for the fold measurement; rows never share heights across it. */
  measureScope?: string;
  scrollRootRef?: RefObject<HTMLElement | null>;
  /** Live output must appear in the same paint, without an estimated-height placeholder. */
  eager?: boolean;
  /** This row was just appended to the tail; reveal it instead of popping in. */
  appended?: boolean;
  children: ReactNode;
}

/**
 * Renders one transcript entry, but only once it has come near the viewport.
 *
 * The wrapper itself is always in the DOM so anchor ids and the navigation
 * panel stay correct; the (potentially expensive) entry body is what gets
 * deferred. Mounted entries lay out for real — deliberately no
 * `content-visibility`, because reserving an estimated height for content that
 * is already mounted makes the scrollbar grow while you scroll. Only entries
 * that have never been near the viewport carry a reservation.
 *
 * Bodies are never unmounted again once shown: that rendered subtree, plus the
 * `measuredEntryHeights` map, is the cache.
 */
export function TimelineLazyEntry({
  entryId,
  cacheKey,
  estimate,
  measureScope,
  scrollRootRef,
  eager = false,
  appended = false,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Frozen at mount: rows are keyed by entry id, so a row that was appended is
  // a new node. Later renders must not withdraw the class mid-animation.
  const [revealOnAppend] = useState(appended);
  // Without IntersectionObserver (unit tests, older runtimes) render eagerly
  // rather than leaving the transcript permanently blank.
  const [mounted, setMounted] = useState(
    () => eager || typeof IntersectionObserver === "undefined",
  );
  const visible = mounted || eager;
  const reservedHeight =
    measuredEntryHeights.get(cacheKey) ?? estimate ?? FALLBACK_ENTRY_HEIGHT;

  useEffect(() => {
    if (mounted) return;
    if (eager) {
      setMounted(true);
      return;
    }
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }

    const root = scrollRootRef?.current ?? null;
    let shared = viewportObservers.get(root);
    if (!shared) {
      const callbacks = new Map<Element, () => void>();
      const observer = new IntersectionObserver(
        (records) => {
          for (const record of records) {
            if (record.isIntersecting) callbacks.get(record.target)?.();
          }
        },
        { root, rootMargin: PRELOAD_MARGIN },
      );
      shared = { observer, callbacks };
      viewportObservers.set(root, shared);
    }
    shared.callbacks.set(element, () => setMounted(true));
    shared.observer.observe(element);
    return () => {
      shared.callbacks.delete(element);
      shared.observer.unobserve(element);
      if (shared.callbacks.size === 0) {
        shared.observer.disconnect();
        viewportObservers.delete(root);
      }
    };
  }, [mounted, eager, scrollRootRef]);

  useEffect(() => {
    if (!visible || typeof ResizeObserver === "undefined") return;
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver(() => {
      const height = element.getBoundingClientRect().height;
      if (height > 0) {
        measuredEntryHeights.delete(cacheKey);
        measuredEntryHeights.set(cacheKey, height);
        if (measuredEntryHeights.size > 2000)
          measuredEntryHeights.delete(
            measuredEntryHeights.keys().next().value!,
          );
        if (measureScope) {
          const rowKey = `${measureScope}\u0000${entryId}`;
          measuredRowsByScope.delete(rowKey);
          measuredRowsByScope.set(rowKey, height);
          if (measuredRowsByScope.size > 2000)
            measuredRowsByScope.delete(
              measuredRowsByScope.keys().next().value!,
            );
        }
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible, cacheKey, entryId, measureScope]);

  // The switch transition resolves only when every entry in the rendered
  // window has a real body. Two frames let the fresh subtree lay out and the
  // browser commit it before readiness is reported.
  useEffect(() => {
    if (!visible) return;
    const element = ref.current;
    if (!element) return;
    const schedule =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback: FrameRequestCallback) =>
            window.setTimeout(() => callback(performance.now()), 16);
    const cancel =
      typeof cancelAnimationFrame === "function"
        ? cancelAnimationFrame
        : (handle: number) => window.clearTimeout(handle);
    let inner = 0;
    const outer = schedule(() => {
      inner = schedule(() => {
        element.dispatchEvent(
          new CustomEvent(TRANSCRIPT_ENTRY_READY_EVENT, { bubbles: true }),
        );
      });
    });
    return () => {
      cancel(outer);
      cancel(inner);
    };
  }, [visible, cacheKey]);

  return (
    <div
      ref={ref}
      id={sessionEntryDomId(entryId)}
      data-session-entry={entryId}
      data-entry-pending={visible ? undefined : "true"}
      className={revealOnAppend ? "session-entry-appended scroll-mt-4" : "scroll-mt-4"}
      style={visible ? undefined : { minHeight: Math.round(reservedHeight) }}
    >
      {visible ? children : null}
    </div>
  );
}
