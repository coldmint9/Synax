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
    text: "我希望把当前的需求梳理清楚，明确需要完成的事情和最终想达到的效果。",
    finishReason: "stop",
  });
});

it("uses the selected API model without tools and sends a conservative editing contract", async () => {
  expect(await optimizeInput(input)).toEqual({
    text: "我希望把当前的需求梳理清楚，明确需要完成的事情和最终想达到的效果。",
  });
  const [request, signal] = mocks.generate.mock.calls[0];
  expect(request).toMatchObject({
    projectId: "p1",
    model: "openai/current",
    purpose: "input-optimization",
    maxTokens: 512,
  });
  expect(request.tools).toBeUndefined();
  expect(request.messages[0].content).toContain(
    "Make the smallest useful wording changes",
  );
  expect(request.messages[0].content).toContain(
    "If the draft is already clear, return it unchanged",
  );
  expect(request.messages[0].content).toContain(
    "Do not force the draft into one paragraph",
  );
  expect(request.messages[0].content).toContain(
    "Never ask the user a question",
  );
  expect(request.messages[1]).toEqual({ role: "user", content: input.text });
  expect(signal).toBeInstanceOf(AbortSignal);
});

it("does not force a generic expansion for a concise request", async () => {
  const draft = "做成可视化动态交互的页面";
  mocks.generate.mockResolvedValue({
    text: "做成可视化的动态交互页面。",
    finishReason: "stop",
  });

  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: "做成可视化的动态交互页面。",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[0][0].messages[0].content).toContain(
    "The draft is concise",
  );
});

it("keeps structured drafts and protected literals intact", async () => {
  const draft = [
    "修复登录流程：",
    "- 保留接口 `POST /api/login`",
    "- 运行 `npm test`",
    "```ts",
    'const endpoint = "https://example.com/login";',
    "```",
  ].join("\n");
  mocks.generate.mockResolvedValue({
    text: [
      "请修复登录流程：",
      "- 保留接口 `POST /api/login`",
      "- 运行 `npm test`",
      "```ts",
      'const endpoint = "https://example.com/login";',
      "```",
    ].join("\n"),
    finishReason: "stop",
  });

  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: [
      "请修复登录流程：",
      "- 保留接口 `POST /api/login`",
      "- 运行 `npm test`",
      "```ts",
      'const endpoint = "https://example.com/login";',
      "```",
    ].join("\n"),
  });
});

it("repairs a provider response that drops protected content, then accepts a valid rewrite", async () => {
  const draft = "修复 `src/login.ts`，并运行 `npm test`。";
  const repaired = "请修复 `src/login.ts`，完成后运行 `npm test`。";
  mocks.generate
    .mockResolvedValueOnce({
      text: "请修复登录问题。",
      finishReason: "stop",
    })
    .mockResolvedValueOnce({ text: repaired, finishReason: "stop" });

  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: repaired,
  });
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[1][0].messages[0].content).toContain(
    "previous rewrite violated the editing contract",
  );
});

it("falls back to the original draft when the provider keeps violating the contract", async () => {
  const draft = "修复 `src/login.ts`，并运行 `npm test`。";
  mocks.generate.mockResolvedValue({
    text: "以下是一个完整的登录修复方案：\n1. 修改代码",
    finishReason: "stop",
  });

  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: draft,
  });
  expect(mocks.generate).toHaveBeenCalledTimes(2);
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
