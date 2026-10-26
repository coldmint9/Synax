import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: vi.fn(), generate: vi.fn() }));

vi.mock("../../../infrastructure/runtime/config/config-store.js", () => ({
  getGlobalConfig: mocks.config,
}));
vi.mock("../../../infrastructure/llm-runtime/gateway.js", () => ({
  createGatewayStream: async (...args: unknown[]) => {
    const result = await mocks.generate(...args);
    return {
      fullStream: (async function* () {
        for (const text of result.chunks ?? [result.text])
          yield { type: "text-delta", text };
      })(),
      finishReason: Promise.resolve(result.finishReason),
    };
  },
}));

import { INPUT_OPTIMIZATION_TIMEOUT_MS, optimizeInput } from "../input-optimization.js";

const input = {
  projectId: "p1",
  text: "  整理我的需求  ",
  model: "openai/current",
  backendId: "native",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue({
    inputOptimizationModel: "",
    providers: [{ id: "openai", kind: "api" }],
  });
  mocks.generate.mockResolvedValue({
    text: "我希望把当前的需求梳理清楚，明确需要完成的事情和最终想达到的效果。",
    finishReason: "stop",
  });
});

afterEach(() => vi.restoreAllMocks());

it("uses the selected API model without tools and expands intent directly in the user's request", async () => {
  expect(await optimizeInput(input)).toEqual({
    text: "我希望把当前的需求梳理清楚，明确需要完成的事情和最终想达到的效果。",
    status: "optimized",
  });
  const [request, signal] = mocks.generate.mock.calls[0];
  expect(request).toMatchObject({
    projectId: "p1",
    model: "openai/current",
    purpose: "input-optimization",
    maxTokens: 4_096,
    maxRetries: 0,
  });
  expect(request.tools).toBeUndefined();
  expect(request.messages[0].content).toContain(
    "intent-expanding editor",
  );
  expect(request.messages[0].content).toContain(
    "Expand the intent already implied by the draft",
  );
  expect(request.messages[0].content).toContain(
    "Output only the rewritten user message",
  );
  expect(request.messages[0].content).toContain(
    "instead of asking questions or requesting more information",
  );
  expect(request.messages[0].content).toContain(
    "never claim that any work has been changed, fixed, or completed",
  );
  expect(request.messages[1]).toEqual({ role: "user", content: input.text });
  expect(signal).toBeInstanceOf(AbortSignal);
});

it.each([
  { draft: "帮我检查下", rewritten: "请帮我检查一下，指出存在的问题并给出改进建议。" },
  { draft: "做成可视化动态交互的页面", rewritten: "请将其做成可视化页面，支持动态展示和交互操作。" },
])("expands implied intent as a direct user request: $draft", async ({ draft, rewritten }) => {
  mocks.generate.mockResolvedValue({ text: rewritten, finishReason: "stop" });

  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: rewritten,
    status: "optimized",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[0][0].messages[0].content).toContain(
    "Expand its implied goal and work into a concise user request",
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
    status: "optimized",
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

it("preserves the draft without retrying when protected content is missing", async () => {
  const draft = "修复 `src/login.ts`，并运行 `npm test`。";
  const repaired = "请修复 `src/login.ts`，完成后运行 `npm test`。";
  mocks.generate
    .mockResolvedValueOnce({
      text: "请修复登录问题。",
      finishReason: "stop",
    })
    .mockResolvedValueOnce({ text: repaired, finishReason: "stop" });

  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: draft,
    status: "preserved",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it("falls back to the original draft when the provider keeps violating the contract", async () => {
  const draft = "修复 `src/login.ts`，并运行 `npm test`。";
  mocks.generate.mockResolvedValue({
    text: "以下是一个完整的登录修复方案：\n1. 修改代码",
    finishReason: "stop",
  });

  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: draft,
    status: "preserved",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it.each([
  "**目标（推断）**：你希望我对某个对象做一次检查/审阅。\n\n**需要你补充的信息（当前缺失）**：\n- 检查对象：哪段代码或文件路径。",
  "请帮我检查一下。\n\n**需要你补充的信息（当前缺失）**：\n- 检查对象和关注点。",
  "目标：检查某个对象。\n\n待确认：\n- 需要检查的内容。",
  "你希望我检查某个对象，但草稿未指明具体对象。",
  "**Missing information**:\n- Please provide the code to review.",
  "You want to review something, but the subject is unspecified.",
])("keeps the original when the model returns analysis or clarification: %s", async (text) => {
  const draft = "  帮我检查下  ";
  mocks.generate.mockResolvedValue({ text, finishReason: "stop" });
  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: draft,
    status: "preserved",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it("preserves the draft without retrying when the model claims completion", async () => {
  const draft = "修复 `src/login.ts` 的报错。";
  const repaired = "请修复 `src/login.ts` 的报错，并确认报错信息与复现路径。";
  mocks.generate
    .mockResolvedValueOnce({
      text: "我已经修复了 `src/login.ts` 的报错。",
      finishReason: "stop",
    })
    .mockResolvedValueOnce({ text: repaired, finishReason: "stop" });

  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: draft,
    status: "preserved",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it("preserves confirmation content that was already in the draft", async () => {
  const draft = "做成可交互页面，数据源待确认。";
  mocks.generate.mockResolvedValue({
    text: "做成一个可交互的页面，数据源待确认。",
    finishReason: "stop",
  });
  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: "做成一个可交互的页面，数据源待确认。",
    status: "optimized",
  });
});

it("allows report sections when they were already part of the user's draft", async () => {
  const draft = "做成交互页面。\n\n待确认：\n- 数据来源";
  const rewritten = "请做成一个可交互的页面。\n\n待确认：\n- 数据来源";
  mocks.generate.mockResolvedValue({ text: rewritten, finishReason: "stop" });
  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: rewritten,
    status: "optimized",
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
  { text: " ", finishReason: "stop", code: "INPUT_OPTIMIZATION_EMPTY", calls: 1 },
  { text: "partial", finishReason: "length", code: "INPUT_OPTIMIZATION_TRUNCATED", calls: 1 },
  { text: "partial", finishReason: "content-filter", code: "INPUT_OPTIMIZATION_FILTERED", calls: 1 },
  { text: "looks complete", finishReason: "other", code: "INPUT_OPTIMIZATION_INCOMPLETE", calls: 1 },
  { text: "looks complete", finishReason: "tool-calls", code: "INPUT_OPTIMIZATION_INCOMPLETE", calls: 1 },
  { text: "looks complete", finishReason: "error", code: "INPUT_OPTIMIZATION_INCOMPLETE", calls: 1 },
  { text: "x".repeat(32_001), finishReason: "stop", code: "INPUT_OPTIMIZATION_TOO_LONG", calls: 1 },
])("rejects $finishReason results with $code after $calls calls", async ({ text, finishReason, code, calls }) => {
  mocks.generate.mockResolvedValue({ text, finishReason });
  await expect(optimizeInput(input)).rejects.toMatchObject({ code });
  expect(mocks.generate).toHaveBeenCalledTimes(calls);
});

it("delivers deltas before the final validated result", async () => {
  mocks.generate.mockResolvedValue({ chunks: ["- 整理", "我的需求。"], finishReason: "stop" });
  const chunks: string[] = [];
  const result = await optimizeInput(input, undefined, (text) => { chunks.push(text); });
  expect(chunks).toEqual(["- 整理", "我的需求。"]);
  expect(result).toEqual({ text: "- 整理我的需求。", status: "optimized" });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[0][0].reasoningEffort).toBe("none");
});

it("stops streaming when cancelled without another model call", async () => {
  const controller = new AbortController();
  mocks.generate.mockResolvedValue({ chunks: ["- 整理", "我的需求。"], finishReason: "stop" });
  await expect(optimizeInput(input, controller.signal, () => controller.abort()))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it("uses a single deadline for the stream", async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  await expect(optimizeInput(input, undefined, () => {
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
  })).rejects.toMatchObject({ name: "TimeoutError" });
  expect(timeout).toHaveBeenCalledExactlyOnceWith(INPUT_OPTIMIZATION_TIMEOUT_MS);
  expect(mocks.generate).toHaveBeenCalledTimes(1);
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
