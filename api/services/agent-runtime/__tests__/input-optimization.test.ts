import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn(), generate: vi.fn() }));
vi.mock("../../../lib/config/config-store.js", () => ({
  getGlobalConfig: mocks.config,
}));
vi.mock("../../llm-runtime/gateway.js", () => ({
  generateGatewayTextResult: mocks.generate,
}));
import {
  INPUT_OPTIMIZATION_TIMEOUT_MS,
  optimizeInput,
} from "../input-optimization.js";
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
    text: "我希望把当前的需求梳理清楚，明确需要完成的事情和最终想达到的效果。",
    finishReason: "stop",
  });
});

it("limits input optimization to 20 seconds", () => {
  expect(INPUT_OPTIMIZATION_TIMEOUT_MS).toBe(20_000);
});
it("follows the explicit current model and never supplies tools", async () => {
  expect(await optimizeInput(input)).toEqual({
    text: "我希望把当前的需求梳理清楚，明确需要完成的事情和最终想达到的效果。",
  });
  const [request, signal] = mocks.generate.mock.calls[0];
  expect(request).toMatchObject({
    projectId: "p1",
    model: "openai/current",
    purpose: "input-optimization",
  });
  expect(request.tools).toBeUndefined();
  expect(request.messages[0]).toMatchObject({ role: "system" });
  expect(request.messages[0].content).toContain(
    "Your only job is to clarify and rewrite the user's draft",
  );
  expect(request.messages[0].content).toContain(
    "Never ask the user a question",
  );
  expect(request.messages[0].content).toContain(
    "Output only the rewritten paragraph",
  );
  expect(request.messages[1]).toEqual({ role: "user", content: input.text });
  expect(signal).toBeInstanceOf(AbortSignal);
});
it("requires a substantive single-paragraph rewrite without a fixed template", async () => {
  await optimizeInput(input);
  const prompt = mocks.generate.mock.calls[0][0].messages[0].content;
  expect(prompt).toContain("one natural, coherent paragraph");
  expect(prompt).toContain("Do not use a fixed template, headings, labels");
  expect(prompt).toContain("Do more than fix punctuation");
  expect(prompt).toContain("make the intended purpose explicit");
});
it("frames optimization as rewriting rather than answering", async () => {
  await optimizeInput(input);
  const prompt = mocks.generate.mock.calls[0][0].messages[0].content;
  expect(prompt).toContain(
    "Do not answer, solve, explain, recommend, plan, execute",
  );
  expect(prompt).toContain(
    "without inventing details or turning it into a question",
  );
  expect(prompt).not.toContain("items to confirm");
});
it("retries a punctuation-only result with a paragraph rewrite correction", async () => {
  mocks.generate
    .mockResolvedValueOnce({ text: "只是改了标点。", finishReason: "stop" })
    .mockResolvedValueOnce({
      text: "我希望把项目需求梳理清楚，明确目标、约束以及最终希望达到的效果。",
      finishReason: "stop",
    });
  expect(
    await optimizeInput({
      ...input,
      text: "我想把项目需求整理清楚，重点说明目标和约束。",
    }),
  ).toEqual({
    text: "我希望把项目需求梳理清楚，明确目标、约束以及最终希望达到的效果。",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[1][0].messages[0].content).toContain(
    "one natural, coherent paragraph",
  );
});
it("does not add confirmation templates to a short draft", async () => {
  const draft = "做成可视化动态交互的页面";
  mocks.generate.mockResolvedValue({
    text: "请将【待确认：要展示的内容/数据】做成一个可视化、动态、可交互的页面。\n\n需确认：\n- 可视化的具体对象与数据来源",
    finishReason: "stop",
  });
  expect(await optimizeInput({ ...input, text: `  ${draft}  ` })).toEqual({
    text: draft,
  });
});
it("preserves confirmation content that was already in the draft", async () => {
  const draft = "做成可交互页面，数据源待确认。";
  mocks.generate.mockResolvedValue({
    text: "做成一个可交互的页面，数据源待确认。",
    finishReason: "stop",
  });
  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: "做成一个可交互的页面，数据源待确认。",
  });
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
