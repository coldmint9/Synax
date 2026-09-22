import { compactSessionContext } from "../manual-context-compaction.js";
import { snapshotRuntimeReminder } from "../runtime-request-snapshot.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../context-tokenizer.js", () => ({
  countMessagesTokens: (messages: unknown[]) => JSON.stringify(messages).length,
  countTokens: (text: string) => text.length,
}));
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { workRuntime } from "../work-runtime.js";
import { workStore } from "../work-store.js";
import { projectWorkContext } from "../context-projection.js";
import {
  buildLoopModelMessages,
  createLoopHistoryReader,
} from "../loop-model-messages.js";
import { sessionContextBoundary } from "../context-epoch-store.js";
import {
  resetAgentRuntimeFixtures,
  executorInput,
} from "./agent-runtime-fixtures.js";
import { buildLoopToolSet } from "../loop-ai-tools.js";

beforeEach(resetAgentRuntimeFixtures);
// Spies wrap store methods; without restoring, a later spyOn captures the
// previous spy as "original" and recurses.
afterEach(() => vi.restoreAllMocks());
const toolSet = buildLoopToolSet([]);
function fixture(reasoningLength = 2000) {
  const session = agentSessionRuntime.create(executorInput);
  store.appendMessage({
    id: "u",
    sessionId: session.id,
    runId: null,
    stepId: null,
    role: "user",
    content: "Investigate and retain evidence",
    metadata: { source: "turn_request" },
    createdAt: "2026-09-13T00:00:00Z",
  });
  const run = store.appendRun({
    id: "run",
    sessionId: session.id,
    status: "running",
    startedAt: "2026-09-13T00:00:00Z",
    completedAt: null,
    triggerMessageId: "u",
    currentStep: 6,
    model: null,
    stopReason: null,
    metadata: {},
  });
  store.updateSession(session.id, { status: "running", activeRunId: run.id });
  const work = workRuntime.attach(session.id, run);
  for (let n = 1; n <= 6; n++) {
    store.appendRunStep({
      id: `step-${n}`,
      runId: run.id,
      sessionId: session.id,
      index: n,
      status: "completed",
      model: null,
      startedAt: `2026-09-13T00:00:0${n}Z`,
      completedAt: `2026-09-13T00:00:0${n}Z`,
      finishReason: "tool-calls",
      metadata: {
        workId: work.id,
        reasoningParts: [
          {
            text: `private-thought-${n} ` + "x".repeat(reasoningLength),
            providerMetadata: { anthropic: { signature: `signature-${n}` } },
          },
        ],
      },
    });
    store.appendRunPart({
      id: `p-${n}`,
      sessionId: session.id,
      runId: run.id,
      stepId: `step-${n}`,
      kind: "thought",
      sequence: 1,
      content: `private-thought-${n} ` + "x".repeat(reasoningLength),
      toolCallId: null,
      metadata: {},
      createdAt: `2026-09-13T00:00:0${n}Z`,
    });
    store.appendRunPart({
      id: `t-${n}`,
      sessionId: session.id,
      runId: run.id,
      stepId: `step-${n}`,
      kind: "text",
      sequence: 2,
      content: `Finding ${n}, reference p-${n}`,
      toolCallId: null,
      metadata: {},
      createdAt: `2026-09-13T00:00:0${n}Z`,
    });
  }
  return session.id;
}
describe("persistent work context projection", () => {
  it("manually compacts below the hard window while preserving recent steps and source history", () => {
    const sessionId = fixture();
    const input = {
      sessionId,
      toolSet,
      contextLimit: 200000,
      outputReserve: 8192,
      systemTokens: 0,
    };
    expect(projectWorkContext(input).compacted).toBe(false);
    store.updateRun("run", { status: "completed" });
    store.updateSession(sessionId, { status: "completed", activeRunId: null });
    const result = compactSessionContext(sessionId);
    expect(result.compacted).toBe(true);
    expect(result.tokens).toBeLessThan(result.originalTokens);
    expect(result.reason).toBe("manual-compaction");
    const again = projectWorkContext(input);
    expect(JSON.stringify(again.messages)).toContain("signature-6");
    expect(store.listRunParts("step-1")[0].content).toContain(
      "private-thought-1",
    );
    expect(compactSessionContext(sessionId).compacted).toBe(false);
  });
  it("does not bypass pinned boundaries when forced", () => {
    const sessionId = fixture();
    store.updateSessionMetadata(sessionId, {
      contextPinnedStepIds: ["step-1"],
    });
    const result = projectWorkContext({
      sessionId,
      toolSet,
      contextLimit: 200000,
      outputReserve: 8192,
      systemTokens: 0,
      forceCompact: true,
    });
    expect(result.compacted).toBe(false);
    expect(workStore.current(sessionId)?.checkpoint).toBeFalsy();
  });
  it("rejects manual compaction during an active run or for a native CLI backend", () => {
    const sessionId = fixture();
    expect(() => compactSessionContext(sessionId)).toThrow("current run");
    store.updateSessionMetadata(sessionId, {
      backend: { version: 1, id: "codex", model: null, workDir: null },
    });
    expect(() => compactSessionContext(sessionId)).toThrow(
      "manages its own context",
    );
  });

  it("uses a durable boundary and never reconstructs covered reasoning on following requests", () => {
    const sessionId = fixture();
    const input = {
      sessionId,
      toolSet,
      contextLimit: 12000,
      outputReserve: 2000,
      systemTokens: 100,
    };
    const first = projectWorkContext(input);
    expect(first.compacted).toBe(true);
    expect(
      workStore.current(sessionId)?.checkpoint?.throughStepId,
    ).toBeTruthy();
    expect(JSON.stringify(first.messages)).not.toContain("private-thought-1");
    expect(JSON.stringify(first.messages)).toContain("signature-6");
    expect(JSON.stringify(first.messages)).toContain("Finding 1");
    const again = projectWorkContext(input);
    expect(again.messages).toEqual(first.messages);
    expect(again.compacted).toBe(false);
    expect(store.listRunParts("step-1")[0].content).toContain(
      "private-thought-1",
    );
  });
  it("blocks an unsafe window rather than stripping mandatory chain fields", () => {
    const sessionId = fixture();
    expect(() =>
      projectWorkContext({
        sessionId,
        toolSet,
        contextLimit: 1000,
        outputReserve: 500,
        systemTokens: 200,
      }),
    ).toThrow("context_blocked");
  });

  it.each([undefined, false, true])(
    "ignores legacy early-compaction policy with disabled=%s",
    (disabled) => {
      const sessionId = fixture();
      store.updateSessionMetadata(sessionId, {
        contextCompactionPolicy: {
          disabled,
          effectiveWindowCap: 6000,
          prepareRatio: 0.1,
          highRatio: 0.2,
          lowRatio: 0.05,
          minStableRequests: 0,
          minReclaimRatio: 0.01,
        },
        contextCompactionState: {
          version: 1,
          epoch: 0,
          committedRequestCount: 0,
          draft: { version: 1, fromStepId: null, throughStepId: "step-4" },
        },
      });
      const result = projectWorkContext({
        sessionId,
        toolSet,
        contextLimit: 60000,
        outputReserve: 2000,
        systemTokens: 100,
      });
      expect(result.compacted).toBe(false);
      expect(result.compaction?.action).toBe("keep");
      expect(result.compaction?.reason).toBe("within-hard-window");
      expect(result.compaction?.watermarks.budget).toBe(58000);
      expect(workStore.current(sessionId)?.checkpoint).toBeFalsy();
      expect(JSON.stringify(result.messages)).toContain("private-thought-1");
      expect(
        store.getRunStep("step-1").metadata.contextMemorySegment,
      ).toBeUndefined();
      expect(
        store.getSession(sessionId).sessionMetadata?.contextCompactionState,
      ).not.toHaveProperty("draft");
    },
  );

  it.each([120_000, 200_000, 500_000, 920_000])(
    "does not compact a 1M model at %i tokens",
    (tokens) => {
      const sessionId = fixture(Math.ceil(tokens / 6));
      const input = {
        sessionId,
        toolSet,
        contextLimit: 1_000_000,
        outputReserve: 8192,
        systemTokens: 100,
      };
      const original = buildLoopModelMessages(store, sessionId, toolSet);
      const result = projectWorkContext(input);
      expect(result.originalTokens).toBeGreaterThan(tokens);
      expect(result.compacted).toBe(false);
      expect(result.messages).toEqual(original);
      expect(projectWorkContext(input).messages).toEqual(original);
      expect(workStore.current(sessionId)?.checkpoint).toBeFalsy();
      for (let n = 1; n <= 6; n++)
        expect(
          store.getRunStep(`step-${n}`).metadata.contextMemorySegment,
        ).toBeUndefined();
    },
  );

  it("keeps an exact-fit request and rescues only once it crosses the physical boundary", () => {
    const sessionId = fixture();
    const input = {
      sessionId,
      toolSet,
      contextLimit: 1_000_000,
      outputReserve: 8192,
      systemTokens: 100,
    };
    const full = projectWorkContext(input);
    const exact = { ...input, contextLimit: full.tokens + input.outputReserve };
    expect(projectWorkContext(exact).messages).toEqual(full.messages);
    const rescued = projectWorkContext({
      ...exact,
      contextLimit: exact.contextLimit - 1,
    });
    expect(rescued.compacted).toBe(true);
    expect(rescued.compaction?.reason).toBe("hard-pressure");
    expect(rescued.tokens).toBeLessThanOrEqual(full.tokens - 1);
  });

  it.each([true, false])(
    "preserves independent tool clearing with Work=%s",
    (hasWork) => {
      const sessionId = fixture();
      for (let n = 1; n <= 6; n++) {
        store.appendToolCall({
          id: `clear-tc-${n}`,
          sessionId,
          runId: "run",
          stepId: `step-${n}`,
          modelToolCallId: `clear-call-${n}`,
          toolId: n === 1 ? "task.get" : "file.read",
          category: "read",
          mutability: "read",
          argsHash: `hash-${n}`,
          inputRef: { path: `file-${n}` },
          inputSummary: "",
          outputRef: { text: `FULL_TOOL_OUTPUT_${n}` },
          outputSummary: `summary-${n}`,
          status: "completed",
          permissionDecisionId: null,
          startedAt: `2026-09-13T00:00:0${n}Z`,
          endedAt: `2026-09-13T00:00:0${n}Z`,
          error: null,
        });
        store.appendRunPart({
          id: `clear-part-${n}`,
          sessionId,
          runId: "run",
          stepId: `step-${n}`,
          kind: "tool_call",
          sequence: 3,
          content: "",
          toolCallId: `clear-tc-${n}`,
          metadata: {},
          createdAt: `2026-09-13T00:00:0${n}Z`,
        });
      }
      if (!hasWork) vi.spyOn(workStore, "current").mockReturnValue(null);
      const clearing = {
        priorInputTokens: 500_000,
        contextLimit: 1_000_000,
        threshold: 0.5,
        keepRecent: 3,
        excludeTools: ["task.get"],
      };
      const input = {
        sessionId,
        toolSet,
        contextLimit: 1_000_000,
        outputReserve: 8192,
        systemTokens: 100,
        clearing,
      };
      const full = projectWorkContext(input);
      expect(JSON.stringify(full.messages)).toContain("FULL_TOOL_OUTPUT_2");
      const cleared = projectWorkContext({
        ...input,
        clearing: { ...clearing, priorInputTokens: 500_001 },
      });
      expect(cleared.compacted).toBe(false);
      const text = JSON.stringify(cleared.messages);
      expect(text).toContain("private-thought-1");
      expect(text).toContain("result cleared");
      for (const n of [1, 4, 5, 6])
        expect(text).toContain(`FULL_TOOL_OUTPUT_${n}`);
      for (const n of [2, 3])
        expect(text).not.toContain(`FULL_TOOL_OUTPUT_${n}`);
      expect(
        projectWorkContext({
          ...input,
          clearing: { ...clearing, priorInputTokens: 1, forceActivated: true },
        }).messages,
      ).toEqual(cleared.messages);
      expect(
        store.listToolCalls(sessionId).find((c) => c.id === "clear-tc-2")
          ?.outputRef,
      ).toEqual({ text: "FULL_TOOL_OUTPUT_2" });
    },
  );

  it("still rescues at the physical hard window and supports manual compaction while disabled", () => {
    const sessionId = fixture();
    store.updateSessionMetadata(sessionId, {
      contextCompactionPolicy: { disabled: true },
    });
    const rescued = projectWorkContext({
      sessionId,
      toolSet,
      contextLimit: 12000,
      outputReserve: 2000,
      systemTokens: 100,
    });
    expect(rescued.compacted).toBe(true);

    const manualId = fixture();
    store.updateSessionMetadata(manualId, {
      contextCompactionPolicy: { disabled: true },
    });
    store.updateRun("run", { status: "completed" });
    store.updateSession(manualId, { status: "completed", activeRunId: null });
    const manual = compactSessionContext(manualId);
    expect(manual.compacted).toBe(true);
    expect(manual.reason).toBe("manual-compaction");
  });
  it("retains signed tool-call metadata and matching results", () => {
    const sessionId = fixture();
    store.updateRunStep("step-6", {
      metadata: {
        ...store.getRunStep("step-6").metadata,
        toolCallProviderMetadata: {
          call6: { google: { thoughtSignature: "opaque-signature" } },
        },
      },
    });
    store.appendToolCall({
      id: "tc6",
      sessionId,
      runId: "run",
      stepId: "step-6",
      modelToolCallId: "call6",
      toolId: "file.read",
      category: "read",
      mutability: "read",
      argsHash: "hash",
      inputRef: { path: "source.ts" },
      inputSummary: "",
      outputRef: { text: "source" },
      outputSummary: "source",
      status: "completed",
      permissionDecisionId: null,
      startedAt: "2026-09-13T00:00:06Z",
      endedAt: "2026-09-13T00:00:06Z",
      error: null,
    });
    store.appendRunPart({
      id: "call-part",
      sessionId,
      runId: "run",
      stepId: "step-6",
      kind: "tool_call",
      sequence: 3,
      content: "",
      toolCallId: "tc6",
      metadata: {},
      createdAt: "2026-09-13T00:00:06Z",
    });
    const messages = buildLoopModelMessages(store, sessionId, toolSet);
    const text = JSON.stringify(messages);
    expect(text).toContain("opaque-signature");
    const calls = messages
      .flatMap((m) =>
        Array.isArray(m.content)
          ? (m.content as Array<{ type: string; toolCallId?: string }>)
          : [],
      )
      .filter((p) => p.type === "tool-call");
    const results = messages
      .flatMap((m) =>
        Array.isArray(m.content)
          ? (m.content as Array<{ type: string; toolCallId?: string }>)
          : [],
      )
      .filter((p) => p.type === "tool-result");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect((calls[0] as any).toolCallId).toBe((results[0] as any).toolCallId);
  });
});

describe("completed conversation follow-ups", () => {
  it.each([false, true])(
    "preserves history across Work boundaries (compressed=%s)",
    (compressed) => {
      const sessionId = fixture();
      const input = {
        sessionId,
        toolSet,
        contextLimit: compressed ? 12000 : 100000,
        outputReserve: 2000,
        systemTokens: 100,
      };
      const before = projectWorkContext(input);
      expect(before.compacted).toBe(compressed);
      const previous = workStore.current(sessionId)!;
      previous.status = "completed";
      workStore.save(previous);
      store.updateRun("run", { status: "completed" });
      store.updateSession(sessionId, {
        status: "completed",
        activeRunId: null,
      });
      store.appendMessage({
        id: "follow-up",
        sessionId,
        runId: null,
        stepId: null,
        role: "user",
        content: "Explain the earlier findings",
        metadata: { source: "turn_request" },
        createdAt: "2026-09-13T00:01:00Z",
      });
      const run = store.appendRun({
        id: "next-run",
        sessionId,
        status: "running",
        startedAt: "2026-09-13T00:01:00Z",
        completedAt: null,
        triggerMessageId: "follow-up",
        currentStep: 0,
        model: null,
        stopReason: null,
        metadata: {},
      });
      const next = workRuntime.attach(sessionId, run);
      expect(next.id).not.toBe(previous.id);
      expect(next.checkpoint).toBeNull();
      const after = projectWorkContext({ ...input, contextLimit: 100000 });
      expect(after.messages).toEqual([
        ...before.messages,
        { role: "user", content: "Explain the earlier findings" },
      ]);
      expect(after.compacted).toBe(false);
      expect(
        projectWorkContext({ ...input, contextLimit: 100000 }).messages,
      ).toEqual(after.messages);
    },
  );
});

describe("immutable runtime reminders", () => {
  it("reuses the exact snapshot on retry and restores it from serialized metadata", () => {
    const first = snapshotRuntimeReminder(
      {},
      ["Work revision one", "[Step 1]"],
      ["queued-1"],
    );
    const restored = JSON.parse(JSON.stringify({ runtimeReminder: first }));
    expect(
      snapshotRuntimeReminder(
        restored,
        ["changed state must not overwrite"],
        ["queued-2"],
      ),
    ).toEqual(first);
  });
  it("replays old reminders before their assistant response and excludes the in-flight reminder", () => {
    const sessionId = fixture();
    for (let n = 1; n <= 6; n++) {
      const step = store.getRunStep(`step-${n}`);
      store.updateRunStep(step.id, {
        metadata: {
          ...step.metadata,
          runtimeReminder: snapshotRuntimeReminder(
            {},
            [`runtime-state-${n}`],
            [],
          ),
        },
      });
    }
    const messages = buildLoopModelMessages(store, sessionId, toolSet, {
      currentStepId: "step-6",
    });
    const text = JSON.stringify(messages);
    expect(text).not.toContain("runtime-state-6");
    for (let n = 1; n < 6; n++) {
      const index = messages.findIndex(
        (m) =>
          typeof m.content === "string" &&
          m.content.includes(`runtime-state-${n}`),
      );
      expect(index).toBeGreaterThan(0);
      expect(messages[index + 1].role).toBe("assistant");
      expect(text.split(`runtime-state-${n}`)).toHaveLength(2);
    }
    const compacted = projectWorkContext({
      sessionId,
      toolSet,
      contextLimit: 12000,
      outputReserve: 2000,
      systemTokens: 100,
    });
    expect(compacted.compacted).toBe(true);
    expect(JSON.stringify(compacted.messages)).not.toContain("runtime-state-1");
    expect(JSON.stringify(compacted.messages)).toContain("runtime-state-6");
  });
  it("replays equal-timestamp queued inputs at their captured consumption boundary", () => {
    const sessionId = fixture();
    store.appendMessage({
      id: "queued",
      sessionId,
      runId: "run",
      stepId: null,
      role: "user",
      content: "queued-new-instruction",
      metadata: { source: "input_queue" },
      createdAt: "2026-09-13T00:00:01Z",
    });
    for (let n = 1; n <= 6; n++) {
      const step = store.getRunStep(`step-${n}`);
      store.updateRunStep(step.id, {
        metadata: {
          ...step.metadata,
          runtimeReminder: snapshotRuntimeReminder(
            {},
            [`runtime-state-${n}`],
            n >= 3 ? ["queued"] : [],
          ),
        },
      });
    }
    const text = JSON.stringify(
      buildLoopModelMessages(store, sessionId, toolSet),
    );
    expect(text.indexOf("queued-new-instruction")).toBeGreaterThan(
      text.indexOf("Finding 2"),
    );
    expect(text.indexOf("queued-new-instruction")).toBeLessThan(
      text.indexOf("runtime-state-3"),
    );
    expect(text.split("queued-new-instruction")).toHaveLength(2);
    const withoutOld = JSON.stringify(
      buildLoopModelMessages(store, sessionId, toolSet, {
        excludedStepIds: new Set(["step-1", "step-2", "step-3"]),
      }),
    );
    expect(withoutOld).not.toContain("queued-new-instruction");
  });
});

it("honors explicit queue ownership across mixed legacy and snapshot steps with equal timestamps", () => {
  const sessionId = fixture();
  store.appendMessage({
    id: "mixed-queue",
    sessionId,
    runId: "run",
    stepId: null,
    role: "user",
    content: "mixed-new-input",
    metadata: { source: "input_queue", consumedBeforeStepIndex: 2 },
    createdAt: "2026-09-13T00:00:01Z",
  });
  const step = store.getRunStep("step-2");
  store.updateRunStep(step.id, {
    startedAt: "2026-09-13T00:00:01Z",
    metadata: {
      ...step.metadata,
      runtimeReminder: snapshotRuntimeReminder(
        {},
        ["second-step-state"],
        ["mixed-queue"],
      ),
    },
  });
  const text = JSON.stringify(
    buildLoopModelMessages(store, sessionId, toolSet),
  );
  expect(text.indexOf("mixed-new-input")).toBeGreaterThan(
    text.indexOf("Finding 1"),
  );
  expect(text.indexOf("mixed-new-input")).toBeLessThan(
    text.indexOf("second-step-state"),
  );
  expect(text.split("mixed-new-input")).toHaveLength(2);
});

describe("request-local history snapshot", () => {
  const historyMethods = [
    "listMessages",
    "listRuns",
    "listRunSteps",
    "listToolCalls",
    "listRunToolCalls",
    "listRunParts",
  ] as const;

  function countHistoryQueries() {
    const calls: Record<string, number> = {};
    for (const method of historyMethods) {
      const original = store[method].bind(store);
      vi.spyOn(store, method).mockImplementation(((...args: unknown[]) => {
        calls[method] = (calls[method] ?? 0) + 1;
        return (original as (...inner: unknown[]) => unknown)(...args);
      }) as never);
    }
    return calls;
  }

  it("reads each row category once per compaction request instead of per candidate", () => {
    const sessionId = fixture();
    const calls = countHistoryQueries();
    const result = projectWorkContext({
      sessionId,
      toolSet,
      contextLimit: 12000,
      outputReserve: 2000,
      systemTokens: 100,
    });
    expect(result.compacted).toBe(true);
    // Baseline re-read history per candidate cut and per run grouping.
    expect(calls.listMessages).toBe(1);
    expect(calls.listRuns).toBe(1);
    expect(calls.listToolCalls).toBe(1);
    expect(calls.listRunSteps).toBe(1);
    expect(calls.listRunToolCalls ?? 0).toBe(0);
    // One parts read per distinct step, never per candidate.
    expect(calls.listRunParts).toBe(6);
  });

  it("produces byte-identical messages with a shared snapshot and without one", () => {
    const sessionId = fixture();
    const reader = createLoopHistoryReader(store, sessionId);
    const options = {
      excludedStepIds: new Set(["step-1", "step-2"]),
      compactionSummary: "Earlier findings",
      initialUserMessage: undefined,
    };
    const direct = buildLoopModelMessages(store, sessionId, toolSet, options);
    const shared = buildLoopModelMessages(store, sessionId, toolSet, {
      ...options,
      snapshot: reader,
    });
    expect(shared).toEqual(direct);
    expect(JSON.stringify(shared)).toBe(JSON.stringify(direct));

    const calls = countHistoryQueries();
    const again = buildLoopModelMessages(store, sessionId, toolSet, {
      ...options,
      snapshot: reader,
    });
    expect(again).toEqual(direct);
    // The snapshot is already warm: a repeat projection performs no new reads.
    for (const method of historyMethods) expect(calls[method] ?? 0).toBe(0);
  });

  it("groups tool calls by run from one session-wide read without mutating cache order", () => {
    const sessionId = fixture();
    const reader = createLoopHistoryReader(store, sessionId);
    const runs = reader.listRuns();
    const before = runs.map((run) => run.id);
    const expected = new Map(
      before.map((id) => [id, store.listRunToolCalls(id).map((c) => c.id)]),
    );
    const calls = countHistoryQueries();
    for (const run of runs) {
      // Bucketed order must match the store's per-run query exactly.
      expect(reader.listRunToolCalls(run.id).map((c) => c.id)).toEqual(
        expected.get(run.id),
      );
    }
    expect(calls.listToolCalls).toBe(1);
    expect(calls.listRunToolCalls ?? 0).toBe(0);
    expect(reader.listRuns().map((run) => run.id)).toEqual(before);
    // Repeated grouping does not rescan the session-wide snapshot.
    for (let i = 0; i < 5; i++)
      for (const run of runs) reader.listRunToolCalls(run.id);
    expect(calls.listToolCalls).toBe(1);
    // Sorting for replay must not reorder the reader's cached run array.
    buildLoopModelMessages(store, sessionId, toolSet, { snapshot: reader });
    expect(reader.listRuns().map((run) => run.id)).toEqual(before);
  });

  it("reuses the boundary snapshot for the session-wide reader", () => {
    const sessionId = fixture();
    const expectedSteps = store.listRunSteps("run").map((step) => step.id);
    const reader = createLoopHistoryReader(store, sessionId);
    const calls = countHistoryQueries();
    const boundary = sessionContextBoundary(sessionId, reader);
    expect(boundary.steps.map((step) => step.id)).toEqual(expectedSteps);
    // A second call reuses the reader instead of re-querying runs and steps.
    sessionContextBoundary(sessionId, reader);
    expect(calls.listRuns).toBe(1);
    expect(calls.listRunSteps).toBe(1);
  });
});
