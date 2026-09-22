import { buildLoopModelMessages } from "../loop-model-messages.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../context-tokenizer.js", () => ({
  countMessagesTokens: (messages: unknown[]) => JSON.stringify(messages).length,
  countTokens: (text: string) => text.length,
}));
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { workRuntime } from "../work-runtime.js";
import { workStore } from "../work-store.js";
import { buildLoopToolSet } from "../loop-ai-tools.js";
import { projectWorkContext } from "../context-projection.js";
import { snapshotRuntimeReminder } from "../runtime-request-snapshot.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
const toolSet = buildLoopToolSet([]);
beforeEach(resetAgentRuntimeFixtures);
function fixture(count = 10, length = 2800) {
  const session = agentSessionRuntime.create(executorInput);
  store.appendMessage({
    id: "u",
    sessionId: session.id,
    runId: null,
    stepId: null,
    role: "user",
    content: "Investigate the issue. Never delete customer data.",
    metadata: { source: "turn_request" },
    createdAt: "2026-09-15T00:00:00Z",
  });
  const run = store.appendRun({
    id: "run",
    sessionId: session.id,
    status: "running",
    startedAt: "2026-09-15T00:00:00Z",
    completedAt: null,
    triggerMessageId: "u",
    currentStep: count,
    model: null,
    stopReason: null,
    metadata: {},
  });
  store.updateSession(session.id, { status: "running", activeRunId: run.id });
  workRuntime.attach(session.id, run);
  const append = (n: number) => {
    store.appendRunStep({
      id: `s${n}`,
      runId: run.id,
      sessionId: session.id,
      index: n,
      status: "completed",
      model: null,
      startedAt: `2026-09-15T00:00:${String(n).padStart(2, "0")}Z`,
      completedAt: "2026-09-15T00:01:00Z",
      finishReason: "stop",
      metadata: {
        workId: workStore.current(session.id)!.id,
        runtimeReminder: snapshotRuntimeReminder({}, [`state-${n}`], []),
      },
    });
    store.appendRunPart({
      id: `p${n}`,
      runId: run.id,
      stepId: `s${n}`,
      sessionId: session.id,
      kind: "text",
      sequence: 1,
      content: `Decision ${n}: retain transaction isolation.\n\n${"verbose observation ".repeat(Math.ceil(length / 20))}`,
      toolCallId: null,
      metadata: {},
      createdAt: "2026-09-15T00:01:00Z",
    });
  };
  for (let n = 1; n <= count; n++) append(n);
  const input = {
    sessionId: session.id,
    toolSet,
    contextLimit: 40000,
    outputReserve: 2000,
    systemTokens: 100,
  };
  return { sessionId: session.id, append, input };
}
describe("cache-stable context epochs", () => {
  it("keeps the unmodified prefix without preparing memory below the hard window", () => {
    const f = fixture(9);
    const first = projectWorkContext(f.input);
    expect(first.compacted).toBe(false);
    expect(workStore.current(f.sessionId)?.checkpoint).toBeNull();
    expect(
      store.getSession(f.sessionId).sessionMetadata?.contextCompactionState,
    ).not.toHaveProperty("draft");
    expect(
      store.getRunStep("s1").metadata.contextMemorySegment,
    ).toBeUndefined();
    expect(JSON.stringify(first.messages)).not.toContain("context-memory");
    expect(projectWorkContext(f.input).messages).toEqual(first.messages);
  });
  it("rescues an overflowing request with one complete prefix and leaves subsequent requests intact", () => {
    const f = fixture(13);
    const first = projectWorkContext(f.input);
    expect(first.compacted).toBe(true);
    const checkpoint = workStore.current(f.sessionId)!.checkpoint!;
    expect(checkpoint).toMatchObject({ epoch: 1, memory: { version: 1 } });
    expect(first.tokens).toBeLessThan(23000);
    expect(JSON.stringify(first.messages)).toContain(
      "Never delete customer data",
    );
    const again = projectWorkContext(f.input);
    expect(again.messages).toEqual(first.messages);
    expect(again.compacted).toBe(false);
    f.append(14);
    const next = projectWorkContext(f.input);
    expect(next.compacted).toBe(false);
    expect(workStore.current(f.sessionId)?.checkpoint?.throughStepId).toBe(
      checkpoint.throughStepId,
    );
    expect(next.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    expect(store.getRunStep("s1").metadata.contextMemorySegment).toBeTruthy();
    expect(store.listRunParts("s1")[0].content).toContain(
      "verbose observation",
    );
  });
  it("does not mutate checkpoint state when an intact required chain cannot fit", () => {
    const f = fixture(4);
    store.updateSessionMetadata(f.sessionId, { contextPinnedStepIds: ["s1"] });
    expect(() =>
      projectWorkContext({
        ...f.input,
        contextLimit: 3000,
        outputReserve: 1000,
      }),
    ).toThrow("context_blocked");
    expect(workStore.current(f.sessionId)?.checkpoint).toBeNull();
  });
});

it("does not reorder request identities when preparing metadata on an older step", () => {
  const f = fixture(4);
  const before = store.listSessionSteps(f.sessionId).map((step) => step.id);
  store.updateRunStep("s1", {
    metadata: {
      ...store.getRunStep("s1").metadata,
      contextMemorySegment: { version: 1 },
    },
  });
  expect(store.listSessionSteps(f.sessionId).map((step) => step.id)).toEqual(
    before,
  );
});

it("archives the old canonical checkpoint and retains original requirements across two epochs", async () => {
  const f = fixture(13);
  const first = projectWorkContext(f.input);
  expect(first.compacted).toBe(true);
  const old = workStore.current(f.sessionId)!.checkpoint!;
  for (let n = 14; n <= 27; n++) f.append(n);
  const second = projectWorkContext(f.input);
  expect(second.compacted).toBe(true);
  expect(workStore.current(f.sessionId)?.checkpoint?.epoch).toBe(2);
  expect(JSON.stringify(second.messages)).toContain(
    "Never delete customer data",
  );
  expect(
    store.getRunStep(old.throughStepId).metadata.contextCheckpointArchive,
  ).toMatchObject({ summary: old.summary });
  const { contextReferenceTool } = await import("../context-projection.js");
  const result = await contextReferenceTool.execute({
    sessionId: f.sessionId,
    args: { kind: "step", id: old.throughStepId, offset: 0, limit: 100000 },
  } as never);
  expect(JSON.stringify(result)).toContain("contextCheckpointArchive");
});

it("does not prepare optional cuts or candidates to evaluate pricing within the window", () => {
  const f = fixture(11);
  store.updateSessionMetadata(f.sessionId, {
    contextCompactionPolicy: {
      expectedRemainingRequests: 1,
      pricing: {
        cachedInputPerMillion: 0.1,
        cacheWritePerMillion: 1.25,
        summaryCost: 10,
        retrievalCost: 0,
      },
    },
  });
  const result = projectWorkContext(f.input);
  expect(result.compacted).toBe(false);
  expect(result.compaction?.action).toBe("keep");
  expect(result.compaction?.economics.known).toBe(false);
  expect(workStore.current(f.sessionId)?.checkpoint).toBeNull();
});

it("retains timestamp-owned legacy queued constraints when an entire old run is compacted", () => {
  const f = fixture(2, 9000);
  for (const id of ["s1", "s2"])
    store.updateRunStep(id, {
      metadata: { workId: workStore.current(f.sessionId)!.id },
    });
  store.appendMessage({
    id: "legacy-queue",
    sessionId: f.sessionId,
    runId: "run",
    stepId: null,
    role: "user",
    content: "UNIQUE CONSTRAINT: never erase customer receipts.",
    metadata: { source: "input_queue" },
    createdAt: "2026-09-15T00:00:01.500Z",
  });
  store.appendMessage({
    id: "later-user",
    sessionId: f.sessionId,
    runId: null,
    stepId: null,
    role: "user",
    content: "Continue the investigation",
    metadata: { source: "turn_request" },
    createdAt: "2026-09-15T00:02:00Z",
  });
  store.appendRun({
    ...store.getRun("run"),
    id: "later-run",
    triggerMessageId: "later-user",
    startedAt: "2026-09-15T00:02:00Z",
    currentStep: 2,
  });
  for (let n = 1; n <= 2; n++)
    store.appendRunStep({
      ...store.getRunStep("s1"),
      id: `later-s${n}`,
      runId: "later-run",
      index: n,
      metadata: {},
      startedAt: `2026-09-15T00:02:0${n}Z`,
    });
  const result = projectWorkContext({
    ...f.input,
    contextLimit: 18000,
    outputReserve: 2000,
  });
  expect(result.compacted).toBe(true);
  expect(workStore.current(f.sessionId)?.checkpoint?.throughStepId).toBe("s2");
  expect(JSON.stringify(result.messages)).toContain("UNIQUE CONSTRAINT");
  expect(
    workStore
      .current(f.sessionId)
      ?.checkpoint?.memory?.entries.some(
        (entry) => entry.source.id === "legacy-queue" && entry.required,
      ),
  ).toBe(true);
});

it("keeps the full memory index discoverable across a Work transition with legacy step associations", async () => {
  const f = fixture(13);
  for (const step of store.listRunSteps("run"))
    store.updateRunStep(step.id, { metadata: {} });
  const first = projectWorkContext({ ...f.input, contextLimit: 36000 });
  expect(first.compacted).toBe(true);
  const checkpoint = workStore.current(f.sessionId)!.checkpoint!;
  expect(first.messages[0].content).toContain(
    JSON.stringify({ kind: "checkpoint", id: checkpoint.throughStepId }),
  );
  workStore.create(f.sessionId, "A later Work");
  const later = projectWorkContext({ ...f.input, contextLimit: 100000 });
  expect(later.messages).toEqual(first.messages);
  const { contextReferenceTool } = await import("../context-projection.js");
  const result = await contextReferenceTool.execute({
    sessionId: f.sessionId,
    args: {
      kind: "checkpoint",
      id: checkpoint.throughStepId,
      offset: 0,
      limit: 12000,
    },
  } as never);
  expect(JSON.stringify(result)).toContain("omissionIndex");
  expect(JSON.stringify(result)).toContain("sources");
});

it("does not reissue a covered legacy queued constraint as a fresh user message after a partial cut", () => {
  const f = fixture(6, 6000);
  for (const step of store.listRunSteps("run"))
    store.updateRunStep(step.id, {
      metadata: { workId: workStore.current(f.sessionId)!.id },
    });
  const text = "UNIQUE_PARTIAL_CONSTRAINT: never rewrite customer history.";
  store.appendMessage({
    id: "partial-queue",
    sessionId: f.sessionId,
    runId: "run",
    stepId: null,
    role: "user",
    content: text,
    metadata: { source: "input_queue" },
    createdAt: "2026-09-15T00:00:00.500Z",
  });
  const result = projectWorkContext({
    ...f.input,
    contextLimit: 26000,
    outputReserve: 2000,
  });
  expect(result.compacted).toBe(true);
  expect(JSON.stringify(result.messages).split(text)).toHaveLength(2);
  expect(
    result.messages.some(
      (message) => message.role === "user" && message.content === text,
    ),
  ).toBe(false);
  expect(
    projectWorkContext({ ...f.input, contextLimit: 26000, outputReserve: 2000 })
      .messages,
  ).toEqual(result.messages);
});

it("restores epoch identity conservatively from a checkpoint when session scheduling metadata is absent", () => {
  const f = fixture(13);
  projectWorkContext(f.input);
  const checkpoint = workStore.current(f.sessionId)!.checkpoint!;
  store.updateSessionMetadata(f.sessionId, { contextCompactionState: null });
  const restored = projectWorkContext(f.input);
  expect(restored.compaction?.epoch).toBe(checkpoint.epoch);
  expect(restored.compaction?.stableRequests).toBe(0);
  expect(restored.compacted).toBe(false);
  for (let n = 14; n <= 27; n++) f.append(n);
  const next = projectWorkContext(f.input);
  expect(next.compacted).toBe(true);
  expect(workStore.current(f.sessionId)?.checkpoint?.memory?.epoch).toBe(
    workStore.current(f.sessionId)?.checkpoint?.epoch,
  );
});

it("retains media and a message locator when a snapshot-owned queued input is inside a partial cut", async () => {
  const f = fixture(4);
  const inputId = "snapshot-media-queue";
  const { createAsset } = await import("../media-assets.js");
  const asset = await createAsset(
    store.getSession(f.sessionId).projectId,
    "retained.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=",
      "base64",
    ),
    "image/png",
  );
  store.appendMessage({
    id: inputId,
    sessionId: f.sessionId,
    runId: "run",
    stepId: null,
    role: "user",
    content: "Inspect this image",
    contentParts: [
      { type: "text", text: "Inspect this image" },
      { type: "image", assetId: asset.id },
    ],
    metadata: { source: "input_queue", consumedBeforeStepIndex: 1 },
    createdAt: "2026-09-15T00:00:00.500Z",
  });
  const step = store.getRunStep("s1");
  store.updateRunStep(step.id, {
    metadata: {
      ...step.metadata,
      runtimeReminder: snapshotRuntimeReminder({}, ["state-1"], [inputId]),
    },
  });
  // Use the public replay path without trying to hydrate the fixture asset.
  const options = {
    excludedStepIds: new Set(["s1", "s2"]),
    summarizedInputIds: new Set<string>(),
    compactionSummary: "Earlier findings",
  };
  const replay = buildLoopModelMessages(store, f.sessionId, toolSet, options);
  const text = JSON.stringify(replay);
  expect(text).toContain(asset.id);
  expect(text).toContain(inputId);
  expect(text).toContain("use context.read for their original text");
  expect(buildLoopModelMessages(store, f.sessionId, toolSet, options)).toEqual(
    replay,
  );
  expect(
    buildLoopModelMessages(store, f.sessionId, toolSet, {
      ...options,
      summarizedInputIds: new Set([inputId]),
    }),
  ).toEqual(replay);
});

it("stops rescue at the first fitting prefix instead of targeting half the window", () => {
  const f = fixture(40);
  const result = projectWorkContext({ ...f.input, contextLimit: 108000 });
  expect(result.originalTokens).toBeGreaterThan(106000);
  expect(result.compacted).toBe(true);
  expect(result.tokens).toBeLessThanOrEqual(106000);
  expect(result.tokens).toBeGreaterThan(53000);
  expect(workStore.current(f.sessionId)?.checkpoint?.throughStepId).toBe("s8");
});
