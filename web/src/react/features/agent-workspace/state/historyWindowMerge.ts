import type { HistoryWindowResponse } from "../../../../lib/api/agentRuntime";
import type { SessionDetailCacheEntry } from "./agentSessionStore";
import { previewTimelineMessage } from "./timelineHistoryIndex";

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
  ) {
    if (!previous?.timelineIndexLoaded ||
        previous.historyWindow?.epoch !== latest.historyWindow?.epoch ||
        previous.historyWindow?.revision !== latest.historyWindow?.revision) return latest;
    return {
      ...latest,
      timelineMessages: previous.timelineMessages,
      timelineRuns: previous.timelineRuns,
      timelineSteps: previous.timelineSteps,
      timelineToolCalls: previous.timelineToolCalls,
      timelineIndexLoaded: true,
      timelineIndexError: undefined,
    };
  }
  // Without an overlapping row we cannot prove there is no gap between the
  // cached prefix and newest page. Restart rather than display a broken order.
  const loadedIds = new Set(previous.messages.map((message) => message.id));
  if (!latest.messages.some((message) => loadedIds.has(message.id))) {
    if (!previous.timelineIndexLoaded ||
        previous.historyWindow.revision !== latest.historyWindow?.revision) return latest;
    return {
      ...latest,
      timelineMessages: previous.timelineMessages,
      timelineRuns: previous.timelineRuns,
      timelineSteps: previous.timelineSteps,
      timelineToolCalls: previous.timelineToolCalls,
      timelineIndexLoaded: true,
      timelineIndexError: undefined,
    };
  }
  const olderCursor = previous.historyWindow.olderCursor;
  const sameRevision = previous.historyWindow.revision === latest.historyWindow!.revision;
  return {
    ...latest,
    ...combine(previous, latest),
    timelineMessages: sameRevision ? previous.timelineMessages : latest.timelineMessages,
    timelineRuns: sameRevision ? previous.timelineRuns : latest.timelineRuns,
    timelineSteps: sameRevision ? previous.timelineSteps : latest.timelineSteps,
    timelineToolCalls: sameRevision ? previous.timelineToolCalls : latest.timelineToolCalls,
    timelineIndexLoaded: sameRevision ? previous.timelineIndexLoaded : latest.timelineIndexLoaded,
    timelineIndexError: sameRevision ? previous.timelineIndexError : undefined,
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
    timelineMessages: byId(
      older.messages.map(previewTimelineMessage),
      current.timelineMessages ?? current.messages.map(previewTimelineMessage),
    ),
    timelineRuns: byId(older.runs, current.timelineRuns ?? current.runs),
    timelineSteps: byId(older.steps, current.timelineSteps ?? current.steps),
    timelineToolCalls: byId(
      older.toolCalls,
      current.timelineToolCalls ?? current.toolCalls,
    ),
    timelineIndexLoaded: current.timelineIndexLoaded,
    timelineIndexError: current.timelineIndexError,
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
