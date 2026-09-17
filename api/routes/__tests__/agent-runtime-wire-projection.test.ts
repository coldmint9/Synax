import { beforeEach, describe, expect, it } from "vitest";
import { resetAgentRuntimeFixtures, executorInput } from "../../services/agent-runtime/__tests__/agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../../services/agent-runtime/session-runtime.js";
import { agentRuntimeStore } from "../../services/agent-runtime/session-store.js";

async function createSessionWithHeavyArtifacts() {
  const session = agentSessionRuntime.create(executorInput);
  const run = agentRuntimeStore.appendRun({
    id: "run-1",
    sessionId: session.id,
    status: "running",
    startedAt: "2026-09-17T00:00:00Z",
    completedAt: null,
    triggerMessageId: null,
    currentStep: 1,
    model: null,
    stopReason: null,
    metadata: {},
  });
  agentRuntimeStore.appendRunStep({
    id: "step-1",
    runId: run.id,
    sessionId: session.id,
    index: 1,
    status: "completed",
    model: null,
    startedAt: "2026-09-17T00:00:01Z",
    completedAt: "2026-09-17T00:00:02Z",
    finishReason: "stop",
    metadata: {
      reasoningEffort: "high",
      protocol: { protocol: "openai-responses", usage: { raw: "x".repeat(2048) } },
      usage: { totalTokens: 1, raw: { attribution: { items: "y".repeat(2048) } } },
      contextMemorySegment: { blob: "z".repeat(2048) },
    },
  });
  agentRuntimeStore.appendToolCall({
    id: "tc-write",
    sessionId: session.id,
    toolId: "edit_file",
    category: "write",
    mutability: "write",
    inputSummary: "edit",
    outputSummary: "ok",
    status: "completed",
    startedAt: "2026-09-17T00:00:03Z",
    endedAt: "2026-09-17T00:00:04Z",
    error: null,
    runId: run.id,
    stepId: "step-1",
    modelToolCallId: null,
    argsHash: "",
    inputRef: null,
    permissionDecisionId: null,
    outputRef: { diff: "d".repeat(2048) },
  });
  agentRuntimeStore.appendToolCall({
    id: "tc-web",
    sessionId: session.id,
    toolId: "webSearch",
    category: "read",
    mutability: "read",
    inputSummary: "search",
    outputSummary: "results",
    status: "completed",
    startedAt: "2026-09-17T00:00:05Z",
    endedAt: "2026-09-17T00:00:06Z",
    error: null,
    runId: run.id,
    stepId: "step-1",
    modelToolCallId: null,
    argsHash: "",
    inputRef: null,
    permissionDecisionId: null,
    outputRef: { results: [{ title: "kept" }] },
  });
  return session;
}

describe("agent runtime wire projections", () => {
  beforeEach(() => resetAgentRuntimeFixtures());

  it("GET /sessions/:id/steps omits provider-pipeline metadata but keeps reasoningEffort", async () => {
    const session = await createSessionWithHeavyArtifacts();
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");
    const response = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${session.id}/steps`,
    );
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: Array<{ metadata: Record<string, unknown> }> };
    expect(items).toHaveLength(1);
    expect(items[0].metadata).toEqual({ reasoningEffort: "high" });
  });

  it("GET /sessions/:id/tool-calls keeps webSearch outputRef and drops the rest", async () => {
    const session = await createSessionWithHeavyArtifacts();
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");
    const response = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${session.id}/tool-calls`,
    );
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: Array<{ id: string; outputRef?: unknown }> };
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get("tc-web")?.outputRef).toEqual({ results: [{ title: "kept" }] });
    expect(byId.get("tc-write")).not.toHaveProperty("outputRef");
  });

  it("GET /sessions/badges returns sparse rows without session metadata", async () => {
    const session = await createSessionWithHeavyArtifacts();
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");
    const response = await agentRuntimeRoutes.request(
      `http://localhost/sessions/badges?projectIds=${session.projectId}`,
    );
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: Array<Record<string, unknown>> };
    const row = items.find((item) => item.id === session.id);
    expect(row).toMatchObject({ projectId: session.projectId, status: expect.any(String) });
    expect(Object.keys(row ?? {}).sort()).toEqual(["id", "projectId", "status", "updatedAt"]);
  });

  it("GET /sessions list rows omit latestSystemPrompt", async () => {
    const session = await createSessionWithHeavyArtifacts();
    agentRuntimeStore.updateSessionMetadata(session.id, { latestSystemPrompt: "P".repeat(4096) });
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");
    const response = await agentRuntimeRoutes.request(
      `http://localhost/sessions?projectId=${session.projectId}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ sessionMetadata: Record<string, unknown> }> };
    const row = body.items.find((item) => item.sessionMetadata && "latestSystemPrompt" in item.sessionMetadata);
    expect(row).toBeUndefined();
  });
});
