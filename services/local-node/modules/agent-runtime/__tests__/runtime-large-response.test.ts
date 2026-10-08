import { afterEach, beforeEach, expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({
  createGatewayStreamForSelection: vi.fn(),
  resolveGatewaySelection: vi.fn(async () => ({
    model: "fixture/model", providerId: "fixture", modelId: "model",
    apiFormat: "openai-responses",
    provider: { id: "fixture", label: "Fixture", env: [], supported: true, models: [] },
    modelDef: { id: "model", label: "Model" }, config: { providerId: "fixture" },
  })),
}));
vi.mock("../../../infrastructure/llm-runtime/gateway.js", () => gateway);

import { agentLoopRuntime } from "../loop-runtime.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { clearVersionSessionFixture } from "./version-session-fixture.js";
import { ResponsesSnapshotAccumulator } from "../responses-snapshot.js";
import { buildLoopModelMessages } from "../loop-model-messages.js";
import { getRawSqlite } from "../../../infrastructure/database/index.js";
import { assertBatchInput, RUNTIME_ENTITY_BYTES } from "../checkpoints/version-runtime/batch-input.js";
import type { AgentRunStep } from "../contracts.js";
import { initializeVersionNative, versionedSession } from "../checkpoints/version-runtime/bridge.js";
import { readDiagnostic } from "../checkpoints/version-runtime/diagnostics.js";

let sessionId: string | undefined;
beforeEach(() => { resetAgentRuntimeFixtures(); vi.clearAllMocks(); });
afterEach(() => { if (sessionId) clearVersionSessionFixture(sessionId); sessionId = undefined; });

function createVersionedSession() {
  const session = agentSessionRuntime.create({ ...executorInput, workDir: process.cwd() });
  sessionId = session.id;
  store.updateSession(session.id, { status: "completed" });
  initializeVersionNative(
    store.getSession(session.id),
    store.listEvents(session.id),
    session.contextSnapshotId ? store.getContextBundle(session.contextSnapshotId) : undefined,
  );
  expect(versionedSession(session.id)).toBe(true);
  return session;
}

it.each([true, false])("completes a real runtime turn with >1 MiB replay metadata (boundaryOnly=%s)", async (boundaryOnly) => {
  // Match the failure shape: encrypted reasoning duplicated in raw output and
  // very large provider-specific usage attribution. Chinese exercises UTF-8 bytes.
  const encryptedContent = "汉".repeat(400000);
  const signature = { openai: { itemId: "reasoning", reasoningEncryptedContent: encryptedContent } };
  gateway.createGatewayStreamForSelection.mockResolvedValueOnce({
    fullStream: (async function* () {
      yield { type: "reasoning-start", id: "reasoning" };
      yield { type: "reasoning-end", id: "reasoning", providerMetadata: signature };
      yield { type: "text-delta", id: "answer", text: "Completed successfully" };
      yield { type: "raw", rawValue: {
        type: "response.completed",
        response: {
          id: "response-large", status: "completed",
          output: [{ id: "reasoning", type: "reasoning", encrypted_content: encryptedContent }],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, attribution: "x".repeat(2 * 1024 * 1024) },
        },
      } };
      yield { type: "finish", finishReason: "stop" };
    })(),
  });
  const session = createVersionedSession();
  if (boundaryOnly)
    getRawSqlite().prepare("UPDATE conversation_v3_heads SET boundary_only=1 WHERE session_id=?").run(session.id);
  if (!boundaryOnly)
    getRawSqlite().prepare("UPDATE conversation_v3_heads SET boundary_only=0 WHERE session_id=?").run(session.id);
  const chunks = [];
  for await (const chunk of agentLoopRuntime.streamRun(session.id, { message: "Finish the task" })) chunks.push(chunk);
  expect(chunks.some(chunk => chunk.type === "run_failed")).toBe(false);
  expect(store.getSession(session.id).status).toBe("completed");
  const run = store.listRuns(session.id)[0];
  expect(run.status).toBe("completed");
  const step = store.listRunSteps(run.id)[0];
  if (boundaryOnly) {
    expect(() => readDiagnostic(session.id, "steps", step.id)).toThrow(/materialization budget/);
    expect(readDiagnostic(session.id, "steps", step.id, true)?.id).toBe(step.id);
  }
  expect(step.metadata.reasoningParts).toEqual([{ text: "", providerMetadata: signature }]);
  const replay = buildLoopModelMessages(store, session.id, {
    resolveModelToolName: () => null,
    resolveHistoricalModelToolName: (toolId) => toolId,
  });
  expect(replay).toContainEqual(expect.objectContaining({
    role: "assistant",
    content: expect.arrayContaining([
      { type: "reasoning", text: "", providerOptions: signature },
    ]),
  }));
  expect(step.metadata.protocol).toMatchObject({
    responseId: "response-large", status: "completed",
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    diagnosticProjection: { omittedFields: ["output", "usage.extensions"], reason: "diagnostic_byte_budget" },
  });
  expect(store.listMessages(session.id).some(message => message.content === "Completed successfully")).toBe(true);
});

it.each([1, 123456789])("reads a maximum-size admitted entity after adding execution epoch %s", (epoch) => {
  const session = createVersionedSession();
  getRawSqlite().prepare("UPDATE conversation_v3_heads SET boundary_only=0,epoch=? WHERE session_id=?").run(epoch, session.id);
  store.appendRun({
    id: "limit-run", sessionId: session.id, status: "completed",
    startedAt: "now", completedAt: "now", triggerMessageId: null,
    currentStep: 1, stopReason: null, model: null, metadata: {},
  });
  const step: AgentRunStep = {
    id: "limit-step", sessionId: session.id, runId: "limit-run", index: 1,
    status: "completed", startedAt: "now", completedAt: "now",
    finishReason: "stop", model: null, metadata: { payload: "" },
  };
  const bytes = RUNTIME_ENTITY_BYTES - assertBatchInput(step, RUNTIME_ENTITY_BYTES);
  step.metadata.payload = "x".repeat(bytes);
  expect(assertBatchInput(step, RUNTIME_ENTITY_BYTES)).toBe(RUNTIME_ENTITY_BYTES);
  store.appendRunStep(step);
  expect((store.getRunStep(step.id).metadata.payload as string).length).toBe(bytes);
  expect((store.listRunSteps(step.runId)[0].metadata.payload as string).length).toBe(bytes);
  expect(() => store.appendRunStep({
    ...step,
    metadata: { payload: `${step.metadata.payload}x` },
  })).toThrow(/byte budget/);
  expect((store.getRunStep(step.id).metadata.payload as string).length).toBe(bytes);
});

it("retains small raw diagnostics without projecting them", () => {
  const snapshot = new ResponsesSnapshotAccumulator();
  const response = { id: "small", status: "completed", output: [{ id: "item", type: "message" }], usage: { input_tokens: 1, attribution: { detail: "small" } } };
  snapshot.ingest({ type: "response.completed", response });
  expect(snapshot.snapshot()).toEqual({ protocol: "openai-responses", responseId: "small", status: "completed", output: response.output, usage: response.usage });
});
