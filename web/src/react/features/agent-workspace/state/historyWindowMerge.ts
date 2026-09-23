import type { HistoryWindowResponse } from "../../../../lib/api/agentRuntime";
import type { SessionDetailCacheEntry } from "./agentSessionStore";

type Transcript = Pick<
  SessionDetailCacheEntry,
  "messages" | "runs" | "steps" | "toolCalls" | "events" | "permissions"
>;

function byId<T extends { id: string }>(first: T[], second: T[]): T[] {
  const records = new Map(first.map((record) => [record.id, record]));
  for (const record of second) records.set(record.id, record);
  return [...records.values()];
}

function combine(first: Transcript, second: Transcript): Transcript {
  return {
    messages: byId(first.messages, second.messages),
    runs: byId(first.runs, second.runs),
    steps: byId(first.steps, second.steps),
    toolCalls: byId(first.toolCalls, second.toolCalls),
    events: byId(first.events, second.events),
    permissions: byId(first.permissions, second.permissions),
  };
}

/** Preserve browsed pages when a new latest window arrives; discard on rollback. */
export function mergeRefreshedHistory(
  previous: SessionDetailCacheEntry | undefined,
  latest: SessionDetailCacheEntry,
): SessionDetailCacheEntry {
  if (
    !previous?.historyPagesLoaded ||
    !previous.historyWindow ||
    previous.historyWindow.epoch !== latest.historyWindow?.epoch
  ) return latest;
  // Without an overlapping row we cannot prove there is no gap between the
  // cached prefix and newest page. Restart rather than display a broken order.
  const loadedIds = new Set(previous.messages.map((message) => message.id));
  if (!latest.messages.some((message) => loadedIds.has(message.id))) return latest;
  const olderCursor = previous.historyWindow.olderCursor;
  return {
    ...latest,
    ...combine(previous, latest),
    // Events and permissions are a recent snapshot, not archival pages.
    events: latest.events,
    permissions: latest.permissions,
    historyPagesLoaded: true,
    historyWindow: {
      ...latest.historyWindow!,
      olderCursor,
      hasEarlier: Boolean(olderCursor),
    },
  };
}

/** Attach a page to the front while keeping the current newest records authoritative. */
export function prependHistory(
  current: SessionDetailCacheEntry,
  older: HistoryWindowResponse,
): SessionDetailCacheEntry {
  return {
    ...current,
    ...combine(older, current),
    events: current.events,
    permissions: current.permissions,
    historyPagesLoaded: true,
    historyWindow: {
      ...older.historyWindow,
      cursor: undefined,
      latest: true,
      hasEarlier: Boolean(older.historyWindow.olderCursor),
      detailsTruncated:
        Boolean(current.historyWindow?.detailsTruncated) || older.historyWindow.detailsTruncated,
    },
  };
}
