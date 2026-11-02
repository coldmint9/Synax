import { ensureTestRuntime } from "../../../../test-fixtures/rust-runtime.js";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ suggest: vi.fn() }));
vi.mock("../../../modules/agent-runtime/next-input-suggestion.js", () => ({
  suggestNextInput: mocks.suggest,
}));

import { agentRuntimeRoutes } from "../agent-runtime.js";
import { runtimeFacade } from "../../../modules/agent-runtime/sidecar/runtime-facade.js";

const request = (body: unknown) =>
  agentRuntimeRoutes.request("http://localhost/input/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const message = (role: "user" | "assistant", content: string) => ({
  id: `${role}-${content.slice(0, 8)}`,
  sessionId: "session-1",
  runId: null,
  stepId: null,
  role,
  content,
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
});

const toolCall = (toolId: string, startedAt: string) => ({
  id: `${toolId}-${startedAt}`,
  sessionId: "session-1",
  runId: "run-1",
  stepId: "step-1",
  modelToolCallId: null,
  toolId,
  category: "task",
  mutability: "task",
  argsHash: "hash",
  inputSummary: `${toolId} input`,
  inputRef: null,
  outputSummary: `${toolId} output`,
  outputRef: null,
  status: "completed",
  permissionDecisionId: null,
  startedAt,
  endedAt: startedAt,
  error: null,
});

beforeAll(async () => {
  await ensureTestRuntime();
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.suggest.mockResolvedValue("运行测试");
});
afterEach(() => vi.restoreAllMocks());

it("grounds the hint in the last request and the tools of this turn", async () => {
  vi.spyOn(runtimeFacade, "listMessageHistory").mockResolvedValue([
    message("user", "把标题改一下"),
    message("assistant", "改好了"),
  ] as never);
  vi.spyOn(runtimeFacade, "listHistoryObjects").mockResolvedValue([
    toolCall("edit_file", "2026-01-01T00:00:02.000Z"),
    toolCall("read_file", "2026-01-01T00:00:01.000Z"),
  ] as never);

  const response = await request({
    sessionId: "session-1",
    projectId: "p1",
    replySoFar: "标题已经更新",
    model: "provider/model",
    backendId: "native",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ suggestion: "运行测试" });
  expect(mocks.suggest).toHaveBeenCalledWith(
    {
      projectId: "p1",
      userRequest: "把标题改一下",
      replySoFar: "标题已经更新",
      activity: [
        { toolId: "read_file", summary: "read_file output" },
        { toolId: "edit_file", summary: "edit_file output" },
      ],
      model: "provider/model",
      backendId: "native",
    },
    expect.any(AbortSignal),
  );
});

it("returns no hint when the session has no request to answer", async () => {
  vi.spyOn(runtimeFacade, "listMessageHistory").mockResolvedValue([
    message("assistant", "准备好了"),
  ] as never);
  vi.spyOn(runtimeFacade, "listHistoryObjects").mockResolvedValue([] as never);

  const response = await request({ sessionId: "session-1", projectId: "p1" });

  expect(await response.json()).toEqual({ suggestion: null });
  expect(mocks.suggest).not.toHaveBeenCalled();
});

it("keeps a failed hint silent", async () => {
  vi.spyOn(runtimeFacade, "listMessageHistory").mockResolvedValue([
    message("user", "把标题改一下"),
  ] as never);
  vi.spyOn(runtimeFacade, "listHistoryObjects").mockResolvedValue([] as never);
  mocks.suggest.mockRejectedValue(new Error("provider failed"));

  const response = await request({ sessionId: "session-1", projectId: "p1" });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ suggestion: null });
});

it("rejects malformed payloads before reading history", async () => {
  const history = vi.spyOn(runtimeFacade, "listMessageHistory");
  for (const body of [
    null,
    {},
    { sessionId: "session-1" },
    { sessionId: "session-1", projectId: "p1", backendId: "invalid" },
    { sessionId: "session-1", projectId: "p1", unexpected: true },
  ])
    expect((await request(body)).status).toBe(400);
  expect(history).not.toHaveBeenCalled();
  expect(mocks.suggest).not.toHaveBeenCalled();
});
