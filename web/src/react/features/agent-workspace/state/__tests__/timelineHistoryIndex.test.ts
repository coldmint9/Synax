import { describe, expect, it } from "vitest";
import type { HistoryWindowResponse } from "../../../../../lib/api/agentRuntime";
import {
  extendTimelineIndex,
  seedTimelineIndex,
  timelineContainsEntry,
} from "../timelineHistoryIndex";
import type { SessionDetailCacheEntry } from "../agentSessionStore";

function page(
  ids: string[],
  olderCursor?: string,
  cursor?: string,
): HistoryWindowResponse {
  return {
    messages: ids.map((id) => ({
      id,
      sessionId: "session",
      runId: null,
      stepId: null,
      role: "user" as const,
      content: id,
      metadata: {},
      createdAt: id,
    })),
    runs: [],
    steps: [],
    toolCalls: [],
    events: [],
    permissions: [],
    historyWindow: {
      epoch: 1,
      revision: 1,
      cursor,
      olderCursor,
      hasEarlier: Boolean(olderCursor),
      latest: !cursor,
      detailsTruncated: false,
    },
  };
}

function current(): SessionDetailCacheEntry {
  const latest = page(["m3", "m4"], "older");
  return {
    runs: [],
    steps: [],
    events: [],
    messages: latest.messages,
    toolCalls: [],
    permissions: [],
    sessionStats: null,
    sessionTodos: [],
    sessionInvocationUsage: null,
    cachedAt: 1,
    historyWindow: latest.historyWindow,
  };
}

describe("timeline history index", () => {
  it("merges older pages once and removes overlap without changing the transcript payload", () => {
    const latest = page(["m3", "m4"], "older");
    const older = page(["m1", "m2", "m3"], undefined, "older");
    const seeded = seedTimelineIndex(latest);
    const merged = extendTimelineIndex(
      { ...current(), ...seeded },
      older,
    );

    expect(merged.timelineMessages?.map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(merged.timelineIndexLoaded).toBe(true);
    expect(current().messages.map((message) => message.id)).toEqual(["m3", "m4"]);
  });

  it("recognizes folded work-log and answer anchors from indexed steps", () => {
    const entry = {
      ...current(),
      steps: [
        {
          id: "step-1",
          runId: "run-1",
          sessionId: "session",
          index: 0,
          status: "completed" as const,
          model: null,
          startedAt: "2026-09-01T00:00:00.000Z",
          completedAt: "2026-09-01T00:00:01.000Z",
          finishReason: null,
          metadata: {},
        },
      ],
    };

    expect(timelineContainsEntry(entry, "work-log-step-1")).toBe(true);
    expect(timelineContainsEntry(entry, "step-1-answer")).toBe(true);
  });
});
