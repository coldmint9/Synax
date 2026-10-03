import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: vi.fn(), generate: vi.fn() }));

vi.mock("../../../infrastructure/runtime/config/config-store.js", () => ({
  getGlobalConfig: mocks.config,
}));
vi.mock("../../../infrastructure/llm-runtime/gateway.js", () => ({
  generateGatewayTextResult: mocks.generate,
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
    providers: [{ id: "codex-acp", kind: "acp" }],
  });
  mocks.generate.mockResolvedValue({
    text: "我希望把当前的需求梳理清楚，明确需要完成的事情和最终想达到的效果。",
    finishReason: "stop",
  });
});

afterEach(() => vi.restoreAllMocks());

it("uses the selected API model without tools and sends the intent-expansion contract", async () => {
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
    "intent expander",
  );
  expect(request.messages[0].content).toContain(
    "goal-oriented, task-oriented brief",
  );
  expect(request.messages[0].content).toContain(
    "marked as an inference or as a suggestion to confirm",
  );
  expect(request.messages[0].content).toContain(
    "never claim that any work has been changed, fixed, or completed",
  );
  expect(request.messages[1]).toEqual({ role: "user", content: input.text });
  expect(signal).toBeInstanceOf(AbortSignal);
});

it("expands a very short, context-poor draft into an explicit goal and work", async () => {
  const draft = "做成可视化动态交互的页面";
  const expanded =
    "目标：做一个可视化、动态、可交互的页面。\n\n任务：\n1. 明确要展示的数据与来源\n2. 实现图表的动态交互";
  mocks.generate.mockResolvedValue({ text: expanded, finishReason: "stop" });

  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: expanded,
    status: "optimized",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[0][0].messages[0].content).toContain(
    "very short, so most of its context is implicit",
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
    status: "optimized",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[1][0].messages[0].content).toContain(
    "The previous expansion violated the contract",
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
    status: "preserved",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(2);
});

it("accepts an expansion that marks missing information for confirmation", async () => {
  const draft = "做成可视化动态交互的页面";
  const expanded =
    "目标：做一个可视化、动态、可交互的页面。\n\n待确认：\n- 要展示的内容与数据来源";
  mocks.generate.mockResolvedValue({ text: expanded, finishReason: "stop" });
  expect(await optimizeInput({ ...input, text: `  ${draft}  ` })).toEqual({
    text: expanded,
    status: "optimized",
  });
});

it("repairs an expansion that claims the work is already done", async () => {
  const draft = "修复 `src/login.ts` 的报错。";
  const repaired = "请修复 `src/login.ts` 的报错，并确认报错信息与复现路径。";
  mocks.generate
    .mockResolvedValueOnce({
      text: "我已经修复了 `src/login.ts` 的报错。",
      finishReason: "stop",
    })
    .mockResolvedValueOnce({ text: repaired, finishReason: "stop" });

  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: repaired,
    status: "optimized",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[1][0].messages[0].content).toContain(
    "The previous expansion violated the contract",
  );
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
  { text: " ", finishReason: "stop", code: "INPUT_OPTIMIZATION_EMPTY", calls: 3 },
  { text: "partial", finishReason: "length", code: "INPUT_OPTIMIZATION_TRUNCATED", calls: 3 },
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

it.each([
  { text: "partial", finishReason: "length" },
  { text: " ", finishReason: "stop" },
])("recovers from $finishReason without accepting incomplete text", async (result) => {
  mocks.generate
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce({ text: "请整理我的需求。", finishReason: "stop" });
  expect(await optimizeInput(input)).toEqual({ text: "请整理我的需求。", status: "optimized" });
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  const [[first, signal], [second, retrySignal]] = mocks.generate.mock.calls;
  expect(second.maxTokens).toBeGreaterThan(first.maxTokens);
  expect(second.messages).toEqual(first.messages);
  expect(second.model).toBe(input.model);
  expect(second.tools).toBeUndefined();
  expect(second.maxRetries).toBe(0);
  expect(retrySignal).toBe(signal);
});

it("shares the attempt limit between truncation recovery and semantic repair", async () => {
  const draft = "修复 `src/login.ts`。";
  mocks.generate
    .mockResolvedValueOnce({ text: "请修复", finishReason: "length" })
    .mockResolvedValueOnce({ text: "请修复登录。", finishReason: "stop" })
    .mockResolvedValueOnce({ text: "请修复 `src/login.ts`。", finishReason: "stop" });
  expect(await optimizeInput({ ...input, text: draft })).toEqual({
    text: "请修复 `src/login.ts`。", status: "optimized",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(3);
  expect(mocks.generate.mock.calls[2][0].messages[0].content).toContain("previous expansion violated");
});

it("can recover a truncated semantic repair within the shared attempt limit", async () => {
  const draft = "修复 `src/login.ts`。";
  mocks.generate
    .mockResolvedValueOnce({ text: "请修复登录。", finishReason: "stop" })
    .mockResolvedValueOnce({ text: "请修复", finishReason: "length" })
    .mockResolvedValueOnce({ text: "请修复 `src/login.ts`。", finishReason: "stop" });
  expect(await optimizeInput({ ...input, text: draft })).toMatchObject({ status: "optimized" });
  expect(mocks.generate).toHaveBeenCalledTimes(3);
  expect(mocks.generate.mock.calls[2][0].maxTokens).toBeGreaterThan(mocks.generate.mock.calls[1][0].maxTokens);
  expect(mocks.generate.mock.calls[2][0].messages).toEqual(mocks.generate.mock.calls[1][0].messages);
});

it("preserves the exact draft when recovery leaves no semantic repair attempts", async () => {
  const draft = " \n  修复 `src/login.ts`。\n ";
  mocks.generate
    .mockResolvedValueOnce({ text: "", finishReason: "stop" })
    .mockResolvedValueOnce({ text: "partial", finishReason: "length" })
    .mockResolvedValueOnce({ text: "请修复登录。", finishReason: "stop" });
  expect(await optimizeInput({ ...input, text: draft })).toEqual({ text: draft, status: "preserved" });
  expect(mocks.generate).toHaveBeenCalledTimes(3);
});

it("keeps already clear text byte-for-byte, including whitespace and answer-like wording", async () => {
  const draft = " \n我会检查 `src/login.ts`。\n ";
  mocks.generate.mockResolvedValue({ text: draft.trim(), finishReason: "stop" });
  expect(await optimizeInput({ ...input, text: draft })).toEqual({ text: draft, status: "unchanged" });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it("validates completion before treating identical text as unchanged", async () => {
  mocks.generate.mockResolvedValue({ text: input.text, finishReason: "length" });
  await expect(optimizeInput(input)).rejects.toMatchObject({ code: "INPUT_OPTIMIZATION_TRUNCATED" });
  expect(mocks.generate).toHaveBeenCalledTimes(3);
});

it("protects tables even without headings or list markers", async () => {
  const draft = "| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 2 |";
  mocks.generate.mockResolvedValue({ text: "苹果有两个。", finishReason: "stop" });
  expect(await optimizeInput({ ...input, text: draft })).toEqual({ text: draft, status: "preserved" });
  expect(mocks.generate).toHaveBeenCalledTimes(2);
});

it("increases bounded budgets for a long non-Latin draft", async () => {
  mocks.generate.mockResolvedValue({ text: "partial", finishReason: "length" });
  await expect(optimizeInput({ ...input, text: "中".repeat(32_000) })).rejects.toMatchObject({ code: "INPUT_OPTIMIZATION_TRUNCATED" });
  const budgets = mocks.generate.mock.calls.map(([request]) => request.maxTokens);
  expect(budgets).toHaveLength(3);
  // Expansion budgeting starts above the old conservative ceiling of 16_384.
  expect(budgets[0]).toBeGreaterThan(16_384);
  expect(budgets[1]).toBeGreaterThanOrEqual(budgets[0]);
  expect(budgets[2]).toBeGreaterThanOrEqual(budgets[1]);
  expect(budgets[2]).toBeLessThanOrEqual(65_536);
});

it("does not retry or accept a late result after caller cancellation", async () => {
  const controller = new AbortController();
  mocks.generate.mockImplementationOnce(async () => {
    controller.abort();
    return { text: "partial", finishReason: "length" };
  });
  await expect(optimizeInput(input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it("uses one deadline across recovery and rejects a late provider result", async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  mocks.generate
    .mockResolvedValueOnce({ text: "partial", finishReason: "length" })
    .mockImplementationOnce(async () => {
      deadline.abort(new DOMException("Timed out", "TimeoutError"));
      return { text: "请整理我的需求。", finishReason: "stop" };
    });
  await expect(optimizeInput(input)).rejects.toMatchObject({ name: "TimeoutError" });
  expect(timeout).toHaveBeenCalledExactlyOnceWith(INPUT_OPTIMIZATION_TIMEOUT_MS);
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[1][1]).toBe(mocks.generate.mock.calls[0][1]);
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
