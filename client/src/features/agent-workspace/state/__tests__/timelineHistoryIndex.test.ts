import { mergeRefreshedHistory } from "../historyWindowMerge";
import { describe, expect, it } from "vitest";
import type { HistoryWindowResponse } from "../../../../adapters/transport/agentRuntime";
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

it("preserves the completed flat navigation index across ordinary appends", () => {
  const previous = current();
  previous.timelineIndexLoaded = true;
  previous.timelineMessages = page(["m1", "m2", "m3", "m4"]).messages;
  previous.historyWindow = { ...previous.historyWindow!, storage: "rust", generation: 1 };
  const latest = { ...current(), messages: page(["m4", "m5"]).messages, historyWindow: { ...previous.historyWindow, revision: 3, incremental: true } };
  const merged = mergeRefreshedHistory(previous, latest);
  expect(merged.timelineIndexLoaded).toBe(true);
  expect(merged.timelineMessages?.map(message => message.id)).toEqual(["m1","m2","m3","m4","m5"]);
  expect(mergeRefreshedHistory(previous, { ...latest, historyWindow: { ...latest.historyWindow, epoch: 2, generation: 2 } }).timelineIndexLoaded).not.toBe(true);
});

it("updates and removes evicted rail nodes through the incremental feed", () => {
  const previous = { ...current(), ...seedTimelineIndex(page(["m1", "m2", "m3", "m4"])), timelineIndexLoaded: true };
  previous.historyWindow = { ...previous.historyWindow!, generation: 1 };
  previous.messages = previous.messages.map(message => ({ ...message, createdAt: "2026-10-20T00:00:00Z" }));
  const update = { ...current(), messages: [{ ...page(["m1"]).messages[0], content: "Edited older question", createdAt: "2026-10-01T00:00:00Z" }],
    removed: [{ collection: "messages", id: "m2" }],
    historyWindow: { ...previous.historyWindow, incremental: true, revision: 2 } };
  const merged = mergeRefreshedHistory(previous, update);
  expect(merged.messages.map(message => message.id)).toEqual(["m3", "m4"]);
  expect(merged.timelineMessages?.map(message => message.id)).toEqual(["m1", "m3", "m4"]);
  expect(merged.timelineMessages?.[0].content).toBe("Edited older question");
  expect(merged.timelineIndexLoaded).toBe(true);
});

it("does not rebuild the complete rail for an unchanged sync watermark", () => {
  const previous = { ...current(), ...seedTimelineIndex(page(["m1", "m2", "m3", "m4"])), timelineIndexLoaded: true };
  previous.historyWindow = { ...previous.historyWindow!, generation: 1 };
  const update = { ...current(), messages: [],
    historyWindow: { ...previous.historyWindow, incremental: true, revision: 2, syncCursor: "next" } };
  const merged = mergeRefreshedHistory(previous, update);
  expect(merged.timelineMessages).toBe(previous.timelineMessages);
  expect(merged.timelineRuns).toBe(previous.timelineRuns);
  expect(merged.timelineSteps).toBe(previous.timelineSteps);
  expect(merged.timelineToolCalls).toBe(previous.timelineToolCalls);
});
