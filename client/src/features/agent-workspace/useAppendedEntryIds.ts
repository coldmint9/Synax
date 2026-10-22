import { useEffect, useMemo, useRef } from "react";

const NONE: ReadonlySet<string> = new Set<string>();

/**
 * Ids that were appended to the tail of the transcript since the last committed
 * render.
 *
 * Only tail growth counts. An earlier-history page lands above everything that
 * is already rendered, a session switch replaces the scope, and folding a
 * finished round reuses ids, so none of them start the reveal animation. A row
 * that already existed is never reported twice.
 */
export function useAppendedEntryIds(
  entries: readonly { id: string }[],
  scope: string | undefined,
): ReadonlySet<string> {
  const previous = useRef<{ scope: string | undefined; ids: Set<string> } | null>(
    null,
  );
  const appended = useMemo(() => {
    const state = previous.current;
    // First paint is history, not an append.
    if (!state || state.scope !== scope) return NONE;
    let lastKnown = -1;
    for (let index = 0; index < entries.length; index += 1)
      if (state.ids.has(entries[index].id)) lastKnown = index;
    if (lastKnown >= entries.length - 1) return NONE;
    const fresh = new Set<string>();
    for (let index = lastKnown + 1; index < entries.length; index += 1) {
      const id = entries[index].id;
      if (!state.ids.has(id)) fresh.add(id);
    }
    return fresh;
  }, [entries, scope]);
  // Committing here keeps the memo above stable for the whole commit, so the
  // reveal flag cannot be withdrawn while its animation is still running.
  useEffect(() => {
    previous.current = { scope, ids: new Set(entries.map((entry) => entry.id)) };
  }, [entries, scope]);
  return appended;
}
