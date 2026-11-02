import type { SessionDetailCacheEntry } from "./agentSessionStore";
import { resumeHistoryCursor, type HistoryBoundary } from "../../../shared/lib/historyWindowCursor";
import { seedTimelineIndex } from "./timelineHistoryIndex";

export const SESSION_TAIL_RETAIN = 100;
export const SESSION_TAIL_HIGH_WATER = 160;
const collections = ["messages", "runs", "steps", "toolCalls", "events", "permissions"] as const;

/** Hysteresis: append into the buffer, then evict a batch. Never shift per message. */
export function compactSessionTail<T extends Pick<SessionDetailCacheEntry,
  typeof collections[number] | "historyWindow" | "historyPagesLoaded" | "historyViewportRetain" |
  "timelineMessages" | "timelineRuns" | "timelineSteps" | "timelineToolCalls" | "timelineIndexLoaded"
>>(entry: T, force = false): T {
  // Only generation-aware windows support identity-based resume after eviction.
  const window = entry.historyWindow;
  if (window?.generation === undefined) return entry;
  const retain = (name: typeof collections[number]) => Math.max(SESSION_TAIL_RETAIN, entry.historyViewportRetain?.[name] ?? 0);
  const threshold = (name: typeof collections[number]) => retain(name) + (force ? 0 : SESSION_TAIL_HIGH_WATER - SESSION_TAIL_RETAIN);
  if (collections.every(name => entry[name].length <= threshold(name))) return entry;
  const next = { ...entry };
  const rows: HistoryBoundary["rows"] = {};
  // Trim leaves before their parents, retaining the contiguous parent suffix
  // needed by every retained message/tool/step and every currently running run.
  const stepIds = new Set<string>();
  const runIds = new Set<string>();
  for (const name of ["messages", "toolCalls", "steps", "runs", "events", "permissions"] as const) {
    const items = entry[name];
    let start = items.length > threshold(name) ? items.length - retain(name) : 0;
    if (name === "toolCalls" || name === "steps" || name === "runs" || name === "permissions") {
      const needed = name === "steps" ? stepIds : runIds;
      const firstNeeded = items.findIndex(item => needed.has(item.id) ||
        (name === "toolCalls" && "stepId" in item && typeof item.stepId === "string" && stepIds.has(item.stepId)) ||
        ("status" in item && ["running", "queued", "waiting_input", "waiting_permission", "pending"].includes(String(item.status))));
      if (firstNeeded >= 0) start = Math.min(start, firstNeeded);
    }
    if (start > 0) {
      (next[name] as Array<{ id: string }>) = items.slice(start);
      rows[name] = items[start].id;
    }
    for (const item of next[name]) {
      if ("stepId" in item && typeof item.stepId === "string") stepIds.add(item.stepId);
      if ("runId" in item && typeof item.runId === "string") runIds.add(item.runId);
    }
  }
  if (!Object.keys(rows).length) return entry;
  const index = seedTimelineIndex(entry);
  return {
    ...next,
    historyPagesLoaded: false,
    historyWindow: {
      ...window, hasEarlier: true,
      olderCursor: resumeHistoryCursor(window.olderCursor, { generation: window.generation, rows }),
    },
    // The rail owns lightweight previews independently of the transcript window.
    // Clicking an evicted anchor loads its body through loadHistoryUntil.
    timelineMessages: entry.timelineMessages ?? index.timelineMessages,
    timelineRuns: entry.timelineRuns ?? index.timelineRuns,
    timelineSteps: entry.timelineSteps ?? index.timelineSteps,
    timelineToolCalls: entry.timelineToolCalls ?? index.timelineToolCalls,
    timelineIndexLoaded: entry.timelineIndexLoaded || !window.hasEarlier,
  };
}

const readers = new Set<string>();
export function setSessionHistoryReading(sessionId: string, reading: boolean): void {
  if (reading) readers.add(sessionId);
  else readers.delete(sessionId);
}
export function isSessionHistoryReading(sessionId: string): boolean { return readers.has(sessionId); }
