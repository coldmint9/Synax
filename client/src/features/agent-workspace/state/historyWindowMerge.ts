import type { HistoryWindowResponse } from "../../../adapters/transport/agentRuntime";
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

const COLLECTIONS = ["messages", "runs", "steps", "toolCalls", "events", "permissions"] as const;

/** A change cursor proves continuity even when the new page has no overlap. */
function applyChanges(previous: SessionDetailCacheEntry, latest: SessionDetailCacheEntry): SessionDetailCacheEntry {
  const deleted = { ...previous.historyDeleted };
  const combined = combine(previous, latest);
  for (const name of COLLECTIONS) {
    const ids = new Set(deleted[name] ?? []);
    for (const item of latest[name]) ids.delete(item.id);
    for (const item of latest.removed ?? []) if (item.collection === name) ids.add(item.id);
    deleted[name] = [...ids];
    (combined[name] as Array<{ id: string }>) = combined[name].filter(item => !ids.has(item.id)).sort((a, b) => {
      const left = a as unknown as Record<string, unknown>, right = b as unknown as Record<string, unknown>;
      if (typeof left.sequence === "number" && typeof right.sequence === "number") return left.sequence - right.sequence;
      return String(left.createdAt ?? left.startedAt ?? left.timestamp ?? "").localeCompare(
        String(right.createdAt ?? right.startedAt ?? right.timestamp ?? ""));
    });
  }
  return {
    ...previous, ...latest, ...combined,
    historyDeleted: deleted,
    historyPagesLoaded: previous.historyPagesLoaded,
    timelineMessages: byId(previous.timelineMessages ?? [], latest.messages.map(previewTimelineMessage)).filter(item => !deleted.messages?.includes(item.id)),
    timelineRuns: byId(previous.timelineRuns ?? [], latest.runs).filter(item => !deleted.runs?.includes(item.id)),
    timelineSteps: byId(previous.timelineSteps ?? [], latest.steps).filter(item => !deleted.steps?.includes(item.id)),
    timelineToolCalls: byId(previous.timelineToolCalls ?? [], latest.toolCalls).filter(item => !deleted.toolCalls?.includes(item.id)),
    timelineIndexLoaded: previous.timelineIndexLoaded, timelineIndexError: previous.timelineIndexError,
    historyWindow: {
      ...previous.historyWindow!, ...latest.historyWindow!,
      olderCursor: previous.historyWindow!.olderCursor,
      hasEarlier: previous.historyWindow!.hasEarlier,
    },
  };
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

  if (latest.historyWindow?.incremental && previous?.historyWindow &&
      previous.historyWindow.generation === latest.historyWindow.generation) {
    return applyChanges(previous, latest);
  }

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
  const combined = combine(older, current);
  for (const name of COLLECTIONS) {
    const deleted = new Set(current.historyDeleted?.[name] ?? []);
    (combined[name] as Array<{ id: string }>) = combined[name].filter(item => !deleted.has(item.id));
  }
  return {
    ...current,
    ...combined,
    timelineMessages: byId(
      older.messages.map(previewTimelineMessage),
      current.timelineMessages ?? current.messages.map(previewTimelineMessage),
    ).filter(item => !current.historyDeleted?.messages?.includes(item.id)),
    timelineRuns: byId(older.runs, current.timelineRuns ?? current.runs).filter(item => !current.historyDeleted?.runs?.includes(item.id)),
    timelineSteps: byId(older.steps, current.timelineSteps ?? current.steps).filter(item => !current.historyDeleted?.steps?.includes(item.id)),
    timelineToolCalls: byId(
      older.toolCalls,
      current.timelineToolCalls ?? current.toolCalls,
    ).filter(item => !current.historyDeleted?.toolCalls?.includes(item.id)),
    timelineIndexLoaded: current.timelineIndexLoaded,
    timelineIndexError: current.timelineIndexError,
    events: older.historyWindow.generation === undefined ? current.events : combined.events,
    permissions: older.historyWindow.generation === undefined ? current.permissions : combined.permissions,
    historyPagesLoaded: true,
    historyWindow: {
      ...older.historyWindow,
      syncCursor: current.historyWindow?.syncCursor,
      revision: Math.max(current.historyWindow?.revision ?? 0, older.historyWindow.revision),
      cursor: undefined,
      latest: true,
      hasEarlier: Boolean(older.historyWindow.olderCursor),
      detailsTruncated:
        Boolean(current.historyWindow?.detailsTruncated) || older.historyWindow.detailsTruncated,
    },
  };
}
