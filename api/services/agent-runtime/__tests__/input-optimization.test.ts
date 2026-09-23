import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn(), generate: vi.fn() }));
vi.mock("../../../lib/config/config-store.js", () => ({
  getGlobalConfig: mocks.config,
}));
vi.mock("../../llm-runtime/gateway.js", () => ({
  generateGatewayTextResult: mocks.generate,
}));
import { optimizeInput } from "../input-optimization.js";
const input = {
  projectId: "p1",
  text: "  整理我的需求  ",
  model: "openai/current",
  backendId: "native",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockReturnValue({
    inputOptimizationModel: "",
    providers: [{ id: "codex-acp", kind: "acp" }],
  });
  mocks.generate.mockResolvedValue({
    text: "优化后的需求",
    finishReason: "stop",
  });
});
it("follows the explicit current model and never supplies tools", async () => {
  expect(await optimizeInput(input)).toEqual({ text: "优化后的需求" });
  const [request, signal] = mocks.generate.mock.calls[0];
  expect(request).toMatchObject({
    projectId: "p1",
    model: "openai/current",
    purpose: "input-optimization",
  });
  expect(request.tools).toBeUndefined();
  expect(request.messages[0]).toMatchObject({ role: "system" });
  expect(request.messages[1]).toEqual({ role: "user", content: input.text });
  expect(signal).toBeInstanceOf(AbortSignal);
});
it("uses the saved override even for an external backend", async () => {
  mocks.config.mockReturnValue({
    inputOptimizationModel: "custom/fixed",
    providers: [],
  });
  await optimizeInput({ ...input, backendId: "codex", model: undefined });
  expect(mocks.generate.mock.calls[0][0].model).toBe("custom/fixed");
});
it("does not silently choose a different model for missing or external selections", async () => {
  for (const change of [
    { model: undefined },
    { backendId: "codex" },
    { model: "codex-acp/default" },
  ]) {
    await expect(optimizeInput({ ...input, ...change })).rejects.toThrow(
      /设置|Settings/,
    );
  }
  expect(mocks.generate).not.toHaveBeenCalled();
});
it.each(["", "  ", "x".repeat(32_001)])(
  "rejects invalid input before generation",
  async (text) => {
    await expect(optimizeInput({ ...input, text })).rejects.toThrow();
    expect(mocks.generate).not.toHaveBeenCalled();
  },
);
it.each([
  { text: " ", finishReason: "stop" },
  { text: "partial", finishReason: "length" },
  { text: "partial", finishReason: "content-filter" },
])("rejects incomplete or empty results", async (result) => {
  mocks.generate.mockResolvedValue(result);
  await expect(optimizeInput(input)).rejects.toThrow();
});
it("propagates aborts and provider failures", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(optimizeInput(input, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(mocks.generate).not.toHaveBeenCalled();
  mocks.generate.mockRejectedValue(new Error("provider failed"));
  await expect(optimizeInput(input)).rejects.toThrow("provider failed");
});
