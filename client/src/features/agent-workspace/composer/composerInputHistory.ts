/**
 * In-memory history of what the user actually submitted from a composer.
 *
 * Deliberately not persisted: the history lives for one app run only, and each
 * scope (a session, or the new-session draft of a project) keeps its own list.
 * Newest entry first; entries are stored trimmed so blank submits and accidental
 * double sends never pollute the list.
 */
export const COMPOSER_HISTORY_LIMIT = 50;

const histories = new Map<string, string[]>();
const EMPTY_HISTORY: readonly string[] = [];

/** A draft (no session yet) and a session never share one history list. */
export function composerHistoryScope(
  projectId: string,
  sessionId: string | null,
): string {
  return `${projectId}:${sessionId ?? "draft"}`;
}

export function recordComposerInput(scope: string, value: string): void {
  const text = value.trim();
  if (!text) return;
  const current = histories.get(scope) ?? [];
  if (current[0] === text) return;
  histories.set(scope, [text, ...current].slice(0, COMPOSER_HISTORY_LIMIT));
}

export function readComposerHistory(scope: string): readonly string[] {
  return histories.get(scope) ?? EMPTY_HISTORY;
}

/** Clears one scope, or every scope when called without an argument. */
export function clearComposerHistory(scope?: string): void {
  if (scope === undefined) histories.clear();
  else histories.delete(scope);
}

/** Where a recall walk currently stands. `index === -1` means "not browsing". */
export interface ComposerHistoryCursor {
  index: number;
  /** The unsent draft stashed when the walk started. */
  draft: string;
}

export const EMPTY_HISTORY_CURSOR: ComposerHistoryCursor = {
  index: -1,
  draft: "",
};

/**
 * One recall step: `-1` walks to an older entry (ArrowUp), `1` back towards the
 * newest one (ArrowDown). Returns the content to show and the new cursor, or
 * `null` when the key should keep its native behaviour (no history yet, walking
 * past the newest entry, or already at the oldest one).
 */
export function recallComposerInput(
  history: readonly string[],
  cursor: ComposerHistoryCursor,
  direction: -1 | 1,
  current: string,
): { content: string; cursor: ComposerHistoryCursor } | null {
  if (!history.length) return null;
  if (direction === -1) {
    const index = cursor.index < 0 ? 0 : cursor.index + 1;
    if (index >= history.length) return null;
    return {
      content: history[index],
      cursor: {
        index,
        draft: cursor.index < 0 ? current : cursor.draft,
      },
    };
  }
  if (cursor.index < 0) return null;
  if (cursor.index === 0)
    return { content: cursor.draft, cursor: EMPTY_HISTORY_CURSOR };
  return {
    content: history[cursor.index - 1],
    cursor: { index: cursor.index - 1, draft: cursor.draft },
  };
}
