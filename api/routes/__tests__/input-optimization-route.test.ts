import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ optimize: vi.fn() }));
vi.mock("../../services/agent-runtime/input-optimization.js", () => ({
  optimizeInput: mocks.optimize,
  MAX_OPTIMIZATION_INPUT_CHARS: 32_000,
}));
import { agentRuntimeRoutes } from "../agent-runtime.js";
import { AgentRuntimeError } from "../../services/agent-runtime/runtime-errors.js";
const request = (body: unknown) =>
  agentRuntimeRoutes.request("http://localhost/input/optimize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => vi.clearAllMocks());
it("accepts draft-only requests and forwards the selected model", async () => {
  mocks.optimize.mockResolvedValue({ text: "优化" });
  const input = {
    projectId: "p1",
    text: "原文",
    model: "provider/model",
    backendId: "native",
  };
  const response = await request(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "优化" });
  expect(mocks.optimize).toHaveBeenCalledWith(input, expect.any(AbortSignal));
});
it("accepts omitted current model for saved override selection", async () => {
  mocks.optimize.mockResolvedValue({ text: "优化" });
  expect(
    (await request({ projectId: "p1", text: "原文", backendId: "codex" }))
      .status,
  ).toBe(200);
});
it("validates blank, oversized, malformed and unexpected data", async () => {
  for (const input of [
    null,
    {},
    { projectId: "p1", text: " " },
    { projectId: "p1", text: "x".repeat(32_001) },
    { projectId: "p1", text: "text", backendId: "invalid" },
    { projectId: "p1", text: "text", tools: ["exec"] },
  ])
    expect((await request(input)).status).toBe(400);
  expect(mocks.optimize).not.toHaveBeenCalled();
  const response = await agentRuntimeRoutes.request(
    "http://localhost/input/optimize",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    },
  );
  expect(response.status).toBe(400);
});
it("exposes actionable model errors instead of an empty success", async () => {
  mocks.optimize.mockRejectedValue(
    new AgentRuntimeError(
      "Choose an API model",
      "INPUT_OPTIMIZATION_MODEL_UNAVAILABLE",
      422,
    ),
  );
  const response = await request({ projectId: "p1", text: "draft" });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    code: "INPUT_OPTIMIZATION_MODEL_UNAVAILABLE",
  });
});
