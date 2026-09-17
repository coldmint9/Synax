import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentRuntimeFixtures } from "../../services/agent-runtime/__tests__/agent-runtime-fixtures.js";
import { agentRuntimeStore } from "../../services/agent-runtime/session-store.js";

const mockCreateGatewayStream = vi.fn();
const mockProviderCheck = vi.hoisted(() => vi.fn());
// The model transport is mocked below; these route tests must not require real credentials.
vi.mock("../../services/llm-runtime/provider-check.js", () => ({
  assertLlmProviderConfigured: mockProviderCheck,
}));

vi.mock("../../services/llm-runtime/gateway.js", () => ({
  createGatewayStream: (...args: unknown[]) => mockCreateGatewayStream(...args),
  resolveGatewaySelection: vi
    .fn()
    .mockRejectedValue(new Error("Mock transport has no live provider.")),
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

async function waitFor(
  check: () => Promise<boolean>,
  attempts = 200,
  delayMs = 10,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Timed out waiting for background runtime completion.");
}

describe("agent runtime routes", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new Error("Network is forbidden in this mocked route test."),
        ),
    );
    resetAgentRuntimeFixtures();
    fs.rmSync(path.resolve("tmp/agent-runtime-route-resume.txt"), {
      force: true,
    });
  });

  it("creates an external backend session without requiring Native API credentials", async () => {
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");
    const response = await agentRuntimeRoutes.request(
      "http://localhost/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "p1",
          profileId: "explorer",
          prompt: "Explore",
          backendId: "codex-acp",
        }),
      },
    );
    expect(response.status).toBe(201);
    expect(mockProviderCheck).not.toHaveBeenCalled();
    expect(
      ((await response.json()) as { session: { sessionMetadata: unknown } })
        .session.sessionMetadata,
    ).toMatchObject({ backend: { id: "codex-acp" } });
  });

  it("streams loop-runtime SSE events and persists assistant output", async () => {
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

    const stream = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${payload.session.id}/turns/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello?" }),
      },
    );
    const text = await stream.text();

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

  it("auto-resumes an approved permission request without a second turn request", async () => {
    const writePath = "tmp/agent-runtime-route-resume.txt";
    mockCreateGatewayStream
      .mockResolvedValueOnce(
        makeToolStep({
          message: "Need approval before writing.",
          toolName: "file_write",
          toolCallId: "route-write",
          args: { path: writePath, content: "route resume" },
        }),
      )
      .mockResolvedValueOnce(
        makeToolStep({
          toolName: "verification_run",
          toolCallId: "route-verify",
          args: {
            command: `node -e "if(require('fs').readFileSync('${writePath}','utf8')!=='route resume')process.exit(1)"`,
            criterion: "Requested behavior",
            purpose: "Verify the resumed file write",
            scope: [writePath],
          },
        }),
      )
      .mockResolvedValueOnce(makeTextStep("Write finished."));
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

    const firstStream = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${payload.session.id}/turns/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Please write the file." }),
      },
    );
    expect(await firstStream.text()).toContain("permission_requested");

    const permissionsResponse = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${payload.session.id}/permissions`,
    );
    const permissionsBody = (await permissionsResponse.json()) as {
      items: Array<{ id: string }>;
    };
    const permissionId = permissionsBody.items[0]?.id;
    expect(permissionId).toBeTruthy();

    const replyResponse = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${payload.session.id}/permissions/${permissionId}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "once" }),
      },
    );
    expect(replyResponse.status).toBe(200);

    // Native Work requires a real verification receipt after an edit; approving
    // the write must not implicitly approve the verification shell command.
    let verificationPermissionId: string | undefined;
    await waitFor(async () => {
      const response = await agentRuntimeRoutes.request(
        `http://localhost/sessions/${payload.session.id}/permissions`,
      );
      const body = (await response.json()) as {
        items: Array<{ id: string; resolvedAt: string | null; action: string }>;
      };
      verificationPermissionId = body.items.find(
        (item) =>
          item.id !== permissionId && item.action === "ask" && !item.resolvedAt,
      )?.id;
      return Boolean(verificationPermissionId);
    });
    const verificationReply = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${payload.session.id}/permissions/${verificationPermissionId}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "once" }),
      },
    );
    expect(verificationReply.status).toBe(200);
    const replay = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${payload.session.id}/permissions/${permissionId}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "once" }),
      },
    );
    expect(replay.status).toBe(200);
    const conflict = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${payload.session.id}/permissions/${permissionId}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "always" }),
      },
    );
    expect(conflict.status).toBe(409);

    await waitFor(async () => {
      const sessionResponse = await agentRuntimeRoutes.request(
        `http://localhost/sessions/${payload.session.id}`,
      );
      const sessionBody = (await sessionResponse.json()) as {
        session: { status: string };
      };
      return sessionBody.session.status === "completed";
    });

    expect(fs.readFileSync(path.resolve(writePath), "utf8")).toBe(
      "route resume",
    );

    const messagesResponse = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${payload.session.id}/messages`,
    );
    const messagesBody = (await messagesResponse.json()) as {
      items: Array<{ role: string; content: string }>;
    };
    expect(
      messagesBody.items.map((item) => `${item.role}:${item.content}`),
    ).toContain("assistant:Write finished.");
  });
});

describe("GET /sessions projected-status pagination", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetAgentRuntimeFixtures();
  });

  function seed(): void {
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
      blockedReason: null,
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
  }

  it("returns projected items with exact totalCount and countByStatus", async () => {
    seed();
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
    expect(body.items[1]).toMatchObject({
      status: "stopping",
      blockedReason: "Stopping execution.",
    });
  });

  it("filters and pages by projected status without dropping counts", async () => {
    seed();
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
