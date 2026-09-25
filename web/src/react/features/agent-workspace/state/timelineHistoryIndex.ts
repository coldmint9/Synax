import type {
  AgentRuntimeMessage,
  HistoryWindowResponse,
} from "../../../../lib/api/agentRuntime";
import type { SessionDetailCacheEntry } from "./agentSessionStore";

// Keep only what the rail needs; the transcript retains its own paged details.
export function previewTimelineMessage(message: AgentRuntimeMessage): AgentRuntimeMessage {
  return {
    ...message,
    // Prompt equality and media-only prompts both affect tick identity.
    content: message.role === "user" ? message.content : message.content.slice(0, 240),
    contentParts: message.role === "user" && !message.content.trim()
      ? message.contentParts
      : undefined,
    metadata: {
      source: message.metadata?.source,
      type: message.metadata?.type,
      kind: message.metadata?.kind,
      partial: message.metadata?.partial,
      forkedFromMessageId: message.metadata?.forkedFromMessageId,
    },
  };
}

function unique<T extends { id: string }>(first: T[], second: T[]): T[] {
  const items = new Map(first.map((item) => [item.id, item]));
  for (const item of second) items.set(item.id, item);
  return [...items.values()];
}

export function extendTimelineIndex(
  current: SessionDetailCacheEntry,
  older: HistoryWindowResponse,
): Pick<SessionDetailCacheEntry, "timelineMessages" | "timelineRuns" | "timelineSteps" | "timelineToolCalls" | "timelineIndexLoaded"> {
  return {
    timelineMessages: unique(older.messages.map(previewTimelineMessage), current.timelineMessages ?? current.messages.map(previewTimelineMessage)),
    timelineRuns: unique(older.runs, current.timelineRuns ?? current.runs),
    timelineSteps: unique(older.steps, current.timelineSteps ?? current.steps),
    timelineToolCalls: unique(older.toolCalls, current.timelineToolCalls ?? current.toolCalls),
    timelineIndexLoaded: !older.historyWindow.olderCursor,
  };
}

export function seedTimelineIndex(
  response: HistoryWindowResponse,
): Pick<SessionDetailCacheEntry, "timelineMessages" | "timelineRuns" | "timelineSteps" | "timelineToolCalls"> {
  return {
    timelineMessages: response.messages.map(previewTimelineMessage),
    timelineRuns: response.runs,
    timelineSteps: response.steps,
    timelineToolCalls: response.toolCalls,
  };
}

export function timelineContainsEntry(entry: SessionDetailCacheEntry, entryId: string): boolean {
  const stepId = entryId.endsWith("-answer")
    ? entryId.slice(0, -"-answer".length)
    : entryId.startsWith("work-log-")
      ? entryId.slice("work-log-".length)
      : null;
  return entry.messages.some((message) => message.id === entryId) ||
    entry.steps.some((step) => step.id === entryId || step.id === stepId) ||
    entry.runs.some((run) => `run-error-${run.id}` === entryId);
}
