import { useEffect, useMemo, useRef } from "react";
import type { ConversationTimelineEntry } from "./buildConversationTimeline";
import { getMeasuredFoldHeight } from "./TimelineLazyEntry";

/** Rows split out of one step carry its id plus `:content:N` / `:activity:N`. */
const ROW_SUFFIX = /:(?:content|activity):\d+$/;
/** The reply a folded round keeps outside the work log. */
const ANSWER_SUFFIX = "-answer";

/** Bound on remembered folds; a session view only ever adds a few per round. */
const MAX_REMEMBERED_FOLDS = 500;

function baseEntryId(id: string): string {
  return id.replace(ROW_SUFFIX, "");
}

/**
 * Work-log rows that appeared because a run finished while the reader watched,
 * mapped to the height of the process rows they replaced.
 *
 * Only a live transition counts. Opening a session, paging history or scrolling
 * a finished round back into view all render a work log for the first time with
 * no expanded rows in front of it, so there is nothing to contract and nothing
 * is reported. The height comes from what those rows actually measured, not from
 * an estimate: the animation has to start exactly where the reader's eye was.
 */
export function useFoldTransition(
  entries: readonly ConversationTimelineEntry[],
  scope: string | undefined,
): ReadonlyMap<string, number> {
  const previous = useRef<{ scope: string | undefined; ids: Set<string> } | null>(
    null,
  );
  const announced = useRef(new Set<string>());
  const transitions = useMemo(() => {
    const seen = previous.current;
    const folded = new Map<string, number>();
    if (!seen || seen.scope !== scope) return folded;
    // A round keeps its answer in its own row, so that step's commentary is
    // still on screen after the fold and must not be measured as collapsed.
    const keepsContent = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== "agent") continue;
      const id = baseEntryId(entry.id);
      if (id.endsWith(ANSWER_SUFFIX))
        keepsContent.add(id.slice(0, -ANSWER_SUFFIX.length));
    }
    for (const entry of entries) {
      if (entry.kind !== "work_log" || announced.current.has(entry.id)) continue;
      const stepIds = entry.turns.map((turn) => turn.stepId);
      // The process rows were on screen a moment ago; that is what folds.
      if (!stepIds.some((stepId) => seen.ids.has(stepId))) continue;
      const height = getMeasuredFoldHeight(scope, stepIds, keepsContent);
      // Virtualized away, or never laid out: nothing to contract from.
      if (height <= 0) continue;
      folded.set(entry.id, height);
    }
    return folded;
  }, [entries, scope]);
  useEffect(() => {
    previous.current = {
      scope,
      ids: new Set(entries.map((entry) => baseEntryId(entry.id))),
    };
    for (const entry of entries) {
      if (entry.kind !== "work_log") continue;
      announced.current.add(entry.id);
    }
    if (announced.current.size > MAX_REMEMBERED_FOLDS) {
      announced.current.delete(announced.current.values().next().value!);
    }
  }, [entries, scope]);
  return transitions;
}
