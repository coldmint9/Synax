import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentRuntimeFixtures } from "../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js";
import { agentRuntimeStore } from "../../../modules/agent-runtime/session-store.js";

const mockCreateGatewayStream = vi.fn();
const mockProviderCheck = vi.hoisted(() => vi.fn());
const fixture = vi.hoisted(() => ({ baseUrl: "" }));
let provider: http.Server;
// The model transport is mocked below; these route tests must not require real credentials.
vi.mock("../../../infrastructure/llm-runtime/provider-check.js", () => ({
  assertLlmProviderConfigured: mockProviderCheck,
}));

vi.mock("../../../infrastructure/llm-runtime/gateway.js", () => ({
  createGatewayStream: (...args: unknown[]) => mockCreateGatewayStream(...args),
  createGatewayStreamForSelection: (...args: unknown[]) =>
    mockCreateGatewayStream(...args),
  resolveGatewaySelection: vi.fn(async () => ({
    providerId: "fixture",
    modelId: "model",
    apiFormat: "openai",
    provider: {
      id: "fixture",
      label: "Fixture",
      models: [],
      npm: "@ai-sdk/openai-compatible",
    },
    modelDef: { id: "model", label: "Model" },
    config: { providerId: "fixture", apiKey: "local", baseUrl: fixture.baseUrl },
  })),
}));

type MockStreamEvent =
  | { type: "text-delta"; text: string; id?: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "finish-step";
      finishReason: string;
      usage?: Record<string, unknown>;
    }
  | {
      type: "finish";
      finishReason: string;
      totalUsage?: Record<string, unknown>;
    };

function makeStream(events: MockStreamEvent[]) {
  return {
    fullStream: (async function* () {
      yield* events;
    })(),
  };
}

function makeTextStep(message: string): ReturnType<typeof makeStream> {
  return makeStream([
    { type: "text-delta", id: "txt", text: message },
    { type: "finish-step", finishReason: "stop", usage: {} },
    { type: "finish", finishReason: "stop", totalUsage: {} },
  ]);
}

function makeToolStep(input: {
  message?: string;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}): ReturnType<typeof makeStream> {
  return makeStream([
    ...(input.message
      ? [{ type: "text-delta" as const, id: "txt", text: input.message }]
      : []),
    {
      type: "tool-call",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.args,
    },
    { type: "finish-step", finishReason: "tool-calls", usage: {} },
    { type: "finish", finishReason: "tool-calls", totalUsage: {} },
  ]);
}

async function submitAndObserve(
  sessionId: string,
  input: Record<string, unknown>,
  mode: "turn" | "continue" = "turn",
): Promise<{ response: Response; text: string }> {
  const accepted = await (await import("../agent-runtime.js")).agentRuntimeRoutes.request(
    `http://localhost/sessions/${sessionId}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        requestId: crypto.randomUUID(),
        mode,
      }),
    },
  );
  expect(accepted.status).toBe(202);
  const { run } = (await accepted.json()) as { run: { id: string } };
  const response = await (await import("../agent-runtime.js")).agentRuntimeRoutes.request(
    `http://localhost/sessions/${sessionId}/runs/${run.id}/stream`,
  );
  return { response, text: await response.text() };
}

describe("agent runtime routes", () => {
  afterEach(async () => {
    const { runCoordinator } = await import("../../../modules/agent-runtime/run-coordinator.js");
    for (const session of agentRuntimeStore.listSessions({ limit: Infinity })) {
      if (session.activeRunId) await runCoordinator.interrupt(session.id, "Route test cleanup");
    }
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetAgentRuntimeFixtures();
    provider = http.createServer(async (request, response) => {
      request.resume();
      await new Promise<void>(resolve => request.on("end", resolve));
      const source = await mockCreateGatewayStream();
      if (!source) { response.writeHead(500); response.end("Unexpected provider request"); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "route-fixture", object: "chat.completion.chunk", model: "model", created: 0 };
      const send = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      for await (const event of source.fullStream as AsyncGenerator<MockStreamEvent>) {
        if (event.type === "text-delta") send({ content: event.text });
        if (event.type === "tool-call") send({ tool_calls: [{ index: 0, id: event.toolCallId, type: "function", function: { name: event.toolName, arguments: JSON.stringify(event.input) } }] });
        if (event.type === "finish") send({}, event.finishReason === "tool-calls" ? "tool_calls" : "stop");
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    fixture.baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  });

  it("does not expose removed legacy session stream endpoints", async () => {
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");
    const turn = await agentRuntimeRoutes.request(
      "http://localhost/sessions/session/turns/stream",
      { method: "POST", body: JSON.stringify({ message: "old" }) },
    );
    const resume = await agentRuntimeRoutes.request(
      "http://localhost/sessions/session/resume/stream",
      { method: "POST", body: JSON.stringify({}) },
    );
    const live = await agentRuntimeRoutes.request(
      "http://localhost/sessions/session/live",
    );

    expect(turn.status).toBe(404);
    expect(resume.status).toBe(404);
    expect(live.status).toBe(404);
  });

  it("creates a media-only session without requiring a chat provider", async () => {
    const configStore = await import("../../../infrastructure/runtime/config/config-store.js");
    const config = configStore.getGlobalConfigForRuntime();
    const studio = {
      id: "custom-api:studio",
      label: "Studio",
      kind: "api" as const,
      status: "live" as const,
      caps: { canFollowUp: true, canCancel: true },
      models: [{
        id: "render-image",
        label: "Render Image",
        capabilities: ["image_generation" as const],
        media: { operations: ["text-to-image" as const] },
      }],
    };
    const configSpy = vi.spyOn(configStore, "getGlobalConfigForRuntime").mockReturnValue({
      ...config,
      providers: [...config.providers, studio],
      providerConnections: {
        ...config.providerConnections,
        [studio.id]: { providerId: studio.id, mediaAdapter: "openrouter", apiKey: "test-key" },
      },
    });
    try {
      const { agentRuntimeRoutes } = await import("../agent-runtime.js");
      const body = {
        projectId: "p1",
        profileId: "executor",
        backendId: "native",
        prompt: "A city at night",
        mediaGeneration: { providerId: studio.id, modelId: "render-image" },
      };
      const created = await agentRuntimeRoutes.request("http://localhost/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(201);
      expect(mockProviderCheck).not.toHaveBeenCalled();
      const session = (await created.json()) as { session: { id: string; status: string } };
      expect(session.session.status).toBe("completed");
      expect(agentRuntimeStore.listMessages(session.session.id)).toEqual([]);

      const invalid = await agentRuntimeRoutes.request("http://localhost/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, mediaGeneration: { providerId: studio.id, modelId: "unknown" } }),
      });
      expect(invalid.status).not.toBe(201);
      expect(mockProviderCheck).not.toHaveBeenCalled();
    } finally {
      configSpy.mockRestore();
    }
  });

  it("streams Rust loop SSE events and persists assistant output", async () => {
    mockCreateGatewayStream.mockResolvedValueOnce(
      makeTextStep("hello runtime"),
    );
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");

    const created = await agentRuntimeRoutes.request(
      "http://localhost/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "p1",
          workDir: process.cwd(),
          profileId: "explorer",
          prompt: "Explore runtime behavior",
        }),
      },
    );
    expect(created.status).toBe(201);
    const payload = (await created.json()) as { session: { id: string } };

    const { response: stream, text } = await submitAndObserve(
      payload.session.id,
      { message: "hello?" },
    );

    expect(stream.status).toBe(200);
    expect(text).toContain("run_started");
    expect(text).toContain("message_delta");
    expect(text).toContain("[DONE]");

    const messages = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${payload.session.id}/messages`,
    );
    const body = (await messages.json()) as {
      items: Array<{ role: string; content: string }>;
    };
    expect(body.items.map((item) => `${item.role}:${item.content}`)).toEqual([
      "user:hello?",
      "assistant:hello runtime",
    ]);
  });

  it("streams a permission request through the Run observation endpoint", async () => {
    mockCreateGatewayStream
      .mockResolvedValueOnce(
        makeToolStep({
          message: "Need approval before writing.",
          toolName: "file.write",
          toolCallId: "route-write",
          args: { path: "tmp/agent-runtime-route-resume.txt", content: "route resume" },
        }),
      );
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");

    const created = await agentRuntimeRoutes.request(
      "http://localhost/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "p1",
          workDir: process.cwd(),
          profileId: "executor",
          prompt: "Write a file",
        }),
      },
    );
    expect(created.status).toBe(201);
    const payload = (await created.json()) as { session: { id: string } };

    const { text: firstStreamText } = await submitAndObserve(
      payload.session.id,
      { message: "Please write the file." },
    );
    expect(firstStreamText).toContain("permission_requested");
  });
});

describe("GET /sessions projected-status pagination", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetAgentRuntimeFixtures();
  });

  async function seed(): Promise<void> {
    const base = (id: string, updatedAt: string) => ({
      id,
      projectId: "p1",
      parentSessionId: null,
      childSessionIds: [],
      nodeId: null,
      profileId: "explorer",
      title: null,
      prompt: "fixture",
      contextSnapshotId: null,
      thinkingMode: "standard" as const,
      permissionRules: [],
      createdAt: updatedAt,
      updatedAt,
      completedAt: null,
      resultSummary: null,
      blockedReason: "Needs inspection.",
      skillIds: [],
      mcpServerIds: [],
      activeRunId: null,
      pendingResumeToken: null,
      sessionMetadata: {} as Record<string, unknown>,
    });
    agentRuntimeStore.createSession({
      ...base("c-new", "2026-01-01T00:00:05Z"),
      status: "completed",
    });
    agentRuntimeStore.createSession({
      ...base("stopping", "2026-01-01T00:00:04Z"),
      status: "running",
      sessionMetadata: {
        runtimeControl: { state: "stopping", reason: "Stopping execution." },
      },
    });
    agentRuntimeStore.createSession({
      ...base("unconfirmed", "2026-01-01T00:00:03Z"),
      status: "running",
      sessionMetadata: {
        runtimeControl: { state: "unconfirmed", reason: "Needs inspection." },
      },
    });
    agentRuntimeStore.createSession({
      ...base("running", "2026-01-01T00:00:02Z"),
      status: "running",
    });
    agentRuntimeStore.createSession({
      ...base("c-old", "2026-01-01T00:00:01Z"),
      status: "completed",
    });
    await agentRuntimeStore.flush();
  }

  it("retries cleanup without asking the user to attest to two hidden recovery flags", async () => {
    await seed();
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");
    const response = await agentRuntimeRoutes.request(
      "http://localhost/sessions/unconfirmed/recovery",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: {
        status: string;
        sessionMetadata: { runtimeControl?: unknown };
      };
    };
    expect(body.session.status).toBe("interrupted");
    expect(body.session.sessionMetadata.runtimeControl).toBeNull();
  });

  it("returns projected items with exact totalCount and countByStatus", async () => {
    await seed();
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");
    const response = await agentRuntimeRoutes.request(
      "http://localhost/sessions?projectId=p1&limit=2&offset=0",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{
        id: string;
        status: string;
        blockedReason: string | null;
      }>;
      totalCount: number;
      countByStatus: Record<string, number>;
    };

    expect(body.totalCount).toBe(5);
    expect(body.countByStatus).toEqual({
      completed: 3,
      stopping: 1,
      running: 1,
    });
    expect(body.items.map((item) => item.id)).toEqual(["c-new", "stopping"]);
  });

  it("automatically stops a running session before archiving it", async () => {
    const { agentSessionRuntime } = await import(
      "../../../modules/agent-runtime/session-runtime.js",
    );
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");
    const session = agentSessionRuntime.create({
      projectId: "p1",
      workDir: process.cwd(),
      profileId: "explorer",
      prompt: "Delete while running",
    });

    const response = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${session.id}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      deletedSessionIds: [session.id],
      archivedSessionIds: [session.id],
    });
    expect(agentRuntimeStore.tryGetSession(session.id)).toBeUndefined();
    expect(
      agentRuntimeStore.listArchivedBatches().items.map((item) => item.rootSessionId),
    ).toContain(session.id);
    expect(agentRuntimeStore.restoreArchivedBatch(session.id)).toEqual([
      session.id,
    ]);
    expect(agentRuntimeStore.getSession(session.id).id).toBe(session.id);
  });

  it("filters and pages by projected status without dropping counts", async () => {
    await seed();
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");

    const stopping = await agentRuntimeRoutes.request(
      "http://localhost/sessions?projectId=p1&status=stopping",
    );
    const stoppingBody = (await stopping.json()) as {
      items: Array<{ id: string; status: string }>;
      totalCount: number;
      countByStatus: Record<string, number>;
    };
    expect(stoppingBody.items.map((item) => item.id)).toEqual(["stopping"]);
    expect(stoppingBody.totalCount).toBe(1);
    expect(stoppingBody.countByStatus).toEqual({ stopping: 1 });

    const completed = await agentRuntimeRoutes.request(
      "http://localhost/sessions?projectId=p1&status=completed",
    );
    const completedBody = (await completed.json()) as {
      items: Array<{
        id: string;
        status: string;
        blockedReason: string | null;
      }>;
    };
    expect(completedBody.items.map((item) => item.id)).toEqual([
      "c-new",
      "unconfirmed",
      "c-old",
    ]);
    expect(completedBody.items[1]).toMatchObject({
      status: "completed",
      blockedReason: "Needs inspection.",
    });

    const legacyBlocked = await agentRuntimeRoutes.request(
      "http://localhost/sessions?projectId=p1&status=blocked",
    );
    expect(legacyBlocked.status).toBe(400);

    const running = await agentRuntimeRoutes.request(
      "http://localhost/sessions?projectId=p1&status=running",
    );
    const runningBody = (await running.json()) as {
      items: Array<{ id: string }>;
    };
    expect(runningBody.items.map((item) => item.id)).toEqual(["running"]);

    const secondPage = await agentRuntimeRoutes.request(
      "http://localhost/sessions?projectId=p1&limit=2&offset=3",
    );
    const secondPageBody = (await secondPage.json()) as {
      items: Array<{ id: string }>;
      totalCount: number;
    };
    expect(secondPageBody.items.map((item) => item.id)).toEqual([
      "running",
      "c-old",
    ]);
    expect(secondPageBody.totalCount).toBe(5);
  });
});
