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

import {
  INPUT_OPTIMIZATION_TIMEOUT_MS,
  optimizeInput,
} from "../input-optimization.js";
import {
  INPUT_OPTIMIZATION_SYSTEM_PROMPT,
  classifyDraft,
  detectRewriteStructure,
} from "../input-optimization-policy.js";

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
    intent: "task",
    structure: "prose",
  });
  const [request, signal] = mocks.generate.mock.calls[0];
  expect(request).toMatchObject({
    projectId: "p1",
    model: "openai/current",
    purpose: "input-optimization",
    temperature: 0.3,
    maxTokens: 4_096,
    maxRetries: 0,
  });
  expect(request.tools).toBeUndefined();
  expect(request.messages[0].content).toContain(
    "intent-expanding editor",
  );
  expect(request.messages[0].content).toContain(
    "Turn a wish into an executable request",
  );
  expect(request.messages[0].content).toContain(
    "Never return a draft that asks for work or asks a question unchanged",
  );
  expect(request.messages[0].content).toContain(
    "Use bullets only when the draft asks for several distinct pieces of work",
  );
  expect(request.messages[0].content).toContain(
    "Reply with the rewritten message only",
  );
  expect(request.messages[0].content).toContain(
    "say once, in one line, that this detail should be confirmed before starting",
  );
  expect(request.messages[0].content).toContain(
    "never state or imply that any work was changed, fixed, or completed",
  );
  expect(request.messages[0].content).toContain(
    "no trailing commentary, follow-up questions, or summary",
  );
  expect(request.messages[0].content).toContain(
    "copy a literal exactly as written",
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
    intent: "task",
    structure: "prose",
  });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[0][0].messages[0].content).toContain(
    "The draft is a request.",
  );
});

it.each([
  { draft: "npm install 报错怎么办", focus: "The draft is a request." },
  { draft: "继续", focus: "The draft is a short control message." },
  {
    draft: "为什么登录后一直跳回首页",
    focus: "The draft asks a question.",
  },
  {
    draft: "跑一下\ncd app\nnpm test",
    focus: "The draft already has structure.",
  },
])("matches the rewrite focus to the draft shape: $draft", async ({ draft, focus }) => {
  mocks.generate.mockResolvedValue({ text: "请排查并反馈。", finishReason: "stop" });
  await optimizeInput({ ...input, text: draft });
  expect(mocks.generate.mock.calls[0][0].messages[0].content).toContain(focus);
});

it("renders the few-shot literals without the template escapes", () => {
  expect(INPUT_OPTIMIZATION_SYSTEM_PROMPT).toContain(
    "Draft: 修复 `src/login.ts`，并运行 `npm test`。",
  );
  expect(INPUT_OPTIMIZATION_SYSTEM_PROMPT).not.toContain("\\`");
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

  expect(await optimizeInput({ ...input, text: draft })).toMatchObject({
    status: "optimized",
    intent: "structured",
    structure: "bulleted",
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

it.each([
  {
    reason: "dropped protected literals",
    draft: "修复 `src/login.ts`，并运行 `npm test`。",
    rewritten: "请修复登录问题。",
  },
  {
    reason: "an assistant-style preamble",
    draft: "帮我检查下",
    rewritten: "当然可以，以下是检查结果：未发现问题。",
  },
  {
    reason: "an inferred-goal report with missing-information prompts",
    draft: "帮我检查下",
    rewritten:
      "**目标（推断）**：你希望我对某个对象做一次检查/审阅。\n\n**需要你补充的信息（当前缺失）**：\n- 检查对象：哪段代码或文件路径。",
  },
  {
    reason: "a claimed execution",
    draft: "修复 `src/login.ts` 的报错。",
    rewritten: "我已经修复了 `src/login.ts` 的报错。",
  },
  {
    reason: "a question rewritten as a statement",
    draft: "这个接口能加缓存吗？",
    rewritten: "请说明该接口的缓存情况。",
  },
])(
  "applies the rewrite verbatim even when it contains $reason",
  async ({ draft, rewritten }) => {
    mocks.generate.mockResolvedValue({ text: rewritten, finishReason: "stop" });
    expect(await optimizeInput({ ...input, text: draft })).toMatchObject({
      text: rewritten,
      status: "optimized",
    });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  },
);


it.each([
  { draft: "继续", intent: "meta" },
  { draft: "好的！", intent: "meta" },
  { draft: "继续把剩下的接口写完", intent: "task" },
  { draft: "为什么登录后一直跳回首页", intent: "question" },
  { draft: "can you check this", intent: "question" },
  { draft: "怎么优化这个函数的性能，并加测试", intent: "task" },
  { draft: "做个登录页", intent: "task" },
  {
    draft: "修复登录流程：\n- 保留接口 `POST /api/login`",
    intent: "structured",
  },
  { draft: "跑一下\ncd app\nnpm test", intent: "structured" },
] as const)("classifies $draft as a $intent draft", ({ draft, intent }) => {
  expect(classifyDraft(draft)).toBe(intent);
});

it("reads the returned structure back instead of trusting it", () => {
  expect(
    detectRewriteStructure("- 目标：完成登录页。\n- 范围：仅登录页。", "task"),
  ).toBe("bulleted");
  expect(
    detectRewriteStructure("请实现一个登录页，风格与现有页面保持一致。", "task"),
  ).toBe("prose");
  expect(detectRewriteStructure("```ts\nconst a = 1;\n```", "structured")).toBe(
    "preserved",
  );
});

it("uses the saved override for the native backend", async () => {
  mocks.config.mockReturnValue({
    inputOptimizationModel: "custom/fixed",
    providers: [],
  });
  await optimizeInput({ ...input, backendId: "native", model: undefined });
  expect(mocks.generate.mock.calls[0][0].model).toBe("custom/fixed");
});

it("does not silently choose a different model for missing or external selections", async () => {
  for (const change of [
    { model: undefined },
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
  expect(result).toEqual({
    text: "- 整理我的需求。",
    status: "optimized",
    intent: "task",
    structure: "bulleted",
  });
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
