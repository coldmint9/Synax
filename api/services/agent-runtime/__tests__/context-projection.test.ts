import { snapshotRuntimeReminder } from "../runtime-request-snapshot.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../context-tokenizer.js", () => ({
  countMessagesTokens: (messages: unknown[]) => JSON.stringify(messages).length,
  countTokens: (text: string) => text.length,
}));
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { workRuntime } from "../work-runtime.js";
import { workStore } from "../work-store.js";
import { projectWorkContext } from "../context-projection.js";
import { buildLoopModelMessages } from "../loop-model-messages.js";
import {
  resetAgentRuntimeFixtures,
  executorInput,
} from "./agent-runtime-fixtures.js";
import { buildLoopToolSet } from "../loop-ai-tools.js";

beforeEach(resetAgentRuntimeFixtures);
const toolSet = buildLoopToolSet([]);
function fixture() {
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
            text: `private-thought-${n} ` + "x".repeat(2000),
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
      content: `private-thought-${n} ` + "x".repeat(2000),
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
