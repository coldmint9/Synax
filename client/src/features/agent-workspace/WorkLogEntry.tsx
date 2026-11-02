import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import { useShellStore } from "../../shared/state/shellStore";
import { useLocale } from "../../shared/hooks/useLocale";
import type { ConversationTimelineEntry } from "./buildConversationTimeline";
import { formatWorkDuration } from "./activityText";
import { ActivityDisclosure } from "./ActivityDisclosure";
import { TurnContent } from "./TurnBody";
import { useActivityDisclosure } from "./useActivityDisclosure";

type WorkLogEntryData = Extract<ConversationTimelineEntry, { kind: "work_log" }>;
interface Props {
  entry: WorkLogEntryData;
  onExpandChild?: (sessionId: string) => void;
  /**
   * Height the folded process rows occupied right before this row replaced
   * them. Present only on the fold itself, so history never replays it.
   */
  foldFrom?: number;
}

/** Longest fold animation, plus slack for a slow frame under load. */
const SETTLE_TIMEOUT_MS = 700;

/**
 * Play the fold as a contract, not a cut.
 *
 * A finished round swaps several process rows for this one line. Starting the
 * wrapper at their measured height and easing down to the settled row keeps the
 * reader's place: the transcript shrinks where the work used to be instead of
 * jumping to a new layout. The exact target height is measured after commit,
 * because only the rendered row knows how tall one line actually is.
 */
function useFoldSettle(foldFrom: number | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  // Frozen at mount: the fold is only reported for the commit that replaces the
  // process rows, and a later render must not restart or cancel the motion.
  const [startHeight] = useState(foldFrom);
  const [settling, setSettling] = useState(Boolean(startHeight));
  useLayoutEffect(() => {
    const element = ref.current;
    const body = element?.firstElementChild;
    if (!startHeight || !element || !(body instanceof HTMLElement)) return;
    const reduceMotion =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    const settled = body.offsetHeight;
    if (reduceMotion || settled <= 0) {
      setSettling(false);
      return;
    }
    element.style.transition = "none";
    element.style.height = `${startHeight}px`;
    // Flush the starting height, otherwise the browser has no value to ease from.
    void element.offsetHeight;
    element.style.transition = "";
    element.style.height = `${settled}px`;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      element.style.height = "";
      setSettling(false);
    };
    element.addEventListener("transitionend", finish, { once: true });
    const timer = window.setTimeout(finish, SETTLE_TIMEOUT_MS);
    return () => {
      element.removeEventListener("transitionend", finish);
      window.clearTimeout(timer);
    };
  }, [startHeight]);
  return { ref, settling };
}

/**
 * One finished round: process and intermediate replies fold into a single row
 * that reports how long the round took. The full record stays one click away —
 * the same activity rows and commentary, in their original order.
 */
export const WorkLogEntry = memo(function WorkLogEntry({
  entry,
  onExpandChild,
  foldFrom,
}: Props) {
  const { locale, t } = useLocale();
  const showThinking = useShellStore(
    (state) => state.preferences.sessionShowThinking,
  );
  const blocks = entry.turns
    .flatMap((turn) => turn.blocks)
    .filter((block) => showThinking || block.type !== "thinking");
  const [expanded, toggle] = useActivityDisclosure(`work-log:${entry.id}`, false);
  const { ref, settling } = useFoldSettle(foldFrom);
  const id = useId();
  // A round without usable timings still folds; it just cannot report a length.
  const duration = formatWorkDuration(entry.stats.elapsedMs, locale);
  const label = duration
    ? t("sessionWorkLogElapsed", { duration })
    : t("sessionWorkLog");

  return (
    <div
      ref={ref}
      className="session-fold-collapse"
      data-settling={settling ? "true" : undefined}
    >
      <section
        className="session-activity-group session-work-log"
        data-expanded={expanded}
      >
        <Button
          type="button"
          className="session-process-trigger"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={id}
        >
          <span className="session-process-summary">{label}</span>
          <ChevronDown
            size={14}
            className="session-process-chevron"
            aria-hidden="true"
          />
        </Button>
        <ActivityDisclosure open={expanded} id={id} className="session-process-window">
          {/* Opening the folded row is a request for the record, so its
              activity groups come up already expanded; collapsing one of them
              is still an explicit choice of the reader's. */}
          <TurnContent
            blocks={blocks}
            rowKeyPrefix={entry.id}
            onExpandChild={onExpandChild}
            defaultExpanded
          />
        </ActivityDisclosure>
      </section>
    </div>
  );
});

export type { WorkLogEntryData };
