import { beforeEach, describe, expect, it } from "vitest";
import { inputQueueService } from "../input-queue-service.js";
import { agentSessionRuntime } from "../session-runtime.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

describe("inputQueueService", () => {
  let sessionId: string;

  beforeEach(() => {
    resetAgentRuntimeFixtures();
    sessionId = agentSessionRuntime.create(executorInput).id;
  });

  it("persists manual moves and consumes items in the new order without changing their contents", () => {
    inputQueueService.enqueue(sessionId, {
      message: "First",
      model: "model-a",
    });
    inputQueueService.enqueue(sessionId, {
      message: "Second",
      reasoningEffort: "high",
    });
    const original = inputQueueService.enqueue(sessionId, { message: "Third" });
    expect(inputQueueService.move(sessionId, original[2].id, "up")).toEqual([
      original[0],
      original[2],
      original[1],
    ]);
    expect(inputQueueService.move(sessionId, original[0].id, "down")).toEqual([
      original[2],
      original[0],
      original[1],
    ]);
    expect(inputQueueService.list(sessionId)).toEqual([
      original[2],
      original[0],
      original[1],
    ]);
    expect(inputQueueService.consumeNext(sessionId)).toEqual(original[2]);
    expect(inputQueueService.consumeNext(sessionId)).toEqual(original[0]);
    expect(inputQueueService.consumeNext(sessionId)).toEqual(original[1]);
  });

  it("leaves boundaries unchanged and never restores an item already consumed", () => {
    inputQueueService.enqueue(sessionId, { message: "First" });
    const items = inputQueueService.enqueue(sessionId, { message: "Second" });
    expect(inputQueueService.move(sessionId, items[0].id, "up")).toEqual(items);
    expect(inputQueueService.move(sessionId, items[1].id, "down")).toEqual(
      items,
    );
    inputQueueService.consumeNext(sessionId);
    expect(() =>
      inputQueueService.move(sessionId, items[0].id, "down"),
    ).toThrow("Queued input not found");
    expect(inputQueueService.list(sessionId)).toEqual([items[1]]);
  });

  it("preserves explicit force-inject priority when moving queued items", () => {
    inputQueueService.enqueue(sessionId, { message: "First" });
    inputQueueService.enqueue(sessionId, { message: "Second" });
    const items = inputQueueService.enqueue(sessionId, { message: "Third" });
    inputQueueService.markForceInject(sessionId, items[1].id);
    inputQueueService.move(sessionId, items[1].id, "down");
    expect(inputQueueService.consumeNext(sessionId)).toEqual(items[1]);
    expect(inputQueueService.list(sessionId)).toEqual([items[0], items[2]]);
  });

  it("enqueues, lists, removes, and drains items in FIFO order", () => {
    const first = inputQueueService.enqueue(sessionId, {
      message: "First message",
    });
    const second = inputQueueService.enqueue(sessionId, {
      message: "Second message",
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(
      inputQueueService.list(sessionId).map((item) => item.message),
    ).toEqual(["First message", "Second message"]);

    const drained = inputQueueService.drainNext(sessionId);
    expect(drained?.message).toBe("First message");
    expect(inputQueueService.list(sessionId)).toHaveLength(1);

    const removed = inputQueueService.remove(sessionId, second[1].id);
    expect(removed).toHaveLength(0);
  });

  it("consumes a force-marked item before FIFO head", () => {
    inputQueueService.enqueue(sessionId, { message: "First" });
    const items = inputQueueService.enqueue(sessionId, { message: "Second" });
    inputQueueService.markForceInject(sessionId, items[1].id);

    const consumed = inputQueueService.consumeForced(sessionId);
    expect(consumed?.message).toBe("Second");
    expect(inputQueueService.getForceInjectId(sessionId)).toBeNull();
    expect(inputQueueService.list(sessionId)).toHaveLength(1);
    expect(inputQueueService.list(sessionId)[0]?.message).toBe("First");
    expect(inputQueueService.consumeForced(sessionId)).toBeNull();
    expect(inputQueueService.list(sessionId)).toHaveLength(1);
  });

  it("does not inject the FIFO head when a forced item is removed", () => {
    inputQueueService.enqueue(sessionId, { message: "First" });
    const items = inputQueueService.enqueue(sessionId, { message: "Second" });
    inputQueueService.markForceInject(sessionId, items[1].id);
    inputQueueService.remove(sessionId, items[1].id);
    expect(inputQueueService.getForceInjectId(sessionId)).toBeNull();
    expect(inputQueueService.consumeForced(sessionId)).toBeNull();
    expect(
      inputQueueService.list(sessionId).map((item) => item.message),
    ).toEqual(["First"]);
  });
});
