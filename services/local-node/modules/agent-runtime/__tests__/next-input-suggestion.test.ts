import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  text: vi.fn(),
  config: vi.fn(),
}));

vi.mock("../../../infrastructure/runtime/config/config-store.js", () => ({
  getGlobalConfig: mocks.config,
}));
vi.mock("../../../infrastructure/llm-runtime/gateway.js", () => ({
  generateGatewayTextResult: mocks.text,
}));

import {
  buildNextInputSuggestionPrompt,
  NEXT_INPUT_SUGGESTION_MAX_CHARS,
  normalizeNextInputSuggestion,
  suggestNextInput,
} from "../next-input-suggestion.js";

const config = (overrides: Record<string, unknown> = {}) => ({
  inputOptimizationModel: "fixture/fast",
  providers: [],
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue(config());
  mocks.text.mockResolvedValue({ text: "运行测试", finishReason: "stop" });
});
afterEach(() => vi.restoreAllMocks());

describe("buildNextInputSuggestionPrompt", () => {
  it("carries the request, the tools run for it, and the reply so far", () => {
    const prompt = buildNextInputSuggestionPrompt({
      userRequest: "把设置页的标题改一下",
      activity: [
        { toolId: "read_file", summary: "SettingsPage.tsx" },
        { toolId: "edit_file", summary: "SettingsPage.tsx" },
      ],
      replySoFar: "已更新标题",
    });

    expect(prompt).toContain("Last user request:\n把设置页的标题改一下");
    expect(prompt).toContain("- read_file: SettingsPage.tsx");
    expect(prompt).toContain("- edit_file: SettingsPage.tsx");
    expect(prompt).toContain("Reply so far:\n已更新标题");
  });

  it("omits empty sections and keeps only the latest tools", () => {
    const prompt = buildNextInputSuggestionPrompt({
      userRequest: "  修一下构建  ",
      activity: Array.from({ length: 12 }, (_, index) => ({
        toolId: `tool-${index}`,
        summary: `step ${index}`,
      })),
    });

    expect(prompt).toContain("Last user request:\n修一下构建");
    expect(prompt).not.toContain("Reply so far:");
    expect(prompt).not.toContain("tool-0");
    expect(prompt).toContain("tool-11");
  });

  it("bounds long requests and tool summaries", () => {
    const prompt = buildNextInputSuggestionPrompt({
      userRequest: "x".repeat(5_000),
      activity: [{ toolId: "read_file", summary: "y".repeat(500) }],
    });

    expect(prompt.length).toBeLessThan(2_400);
    expect(prompt).toContain("…");
  });
});

describe("normalizeNextInputSuggestion", () => {
  it.each([
    // Wrapping backticks are decoration around the message, not part of it.
    ["`code`", "code"],
    ['"运行测试"', "运行测试"],
    ["“提交代码”", "提交代码"],
    ["```text\n运行测试\n```", "运行测试"],
    ["- 运行测试", "运行测试"],
    ["1. 运行测试", "运行测试"],
    ["第一行\n第二行", "第一行"],
    ["   ", null],
    ["", null],
  ])("turns %j into %j", (raw, expected) => {
    expect(normalizeNextInputSuggestion(raw)).toBe(expected);
  });

  it("caps the hint at the composer budget", () => {
    const normalized = normalizeNextInputSuggestion("长".repeat(400));
    expect(normalized?.length).toBe(NEXT_INPUT_SUGGESTION_MAX_CHARS + 1);
    expect(normalized?.endsWith("…")).toBe(true);
  });
});

describe("suggestNextInput", () => {
  it("uses the configured input-optimization model for an isolated call", async () => {
    await expect(
      suggestNextInput({ projectId: "p1", userRequest: "帮我修构建" }),
    ).resolves.toBe("运行测试");

    expect(mocks.text).toHaveBeenCalledTimes(1);
    const [request, signal] = mocks.text.mock.calls[0];
    expect(request).toMatchObject({
      projectId: "p1",
      purpose: "input-suggestion",
      model: "fixture/fast",
      reasoningEffort: "none",
      maxRetries: 0,
      temperature: 0.4,
    });
    expect(request.messages[0].role).toBe("system");
    expect(request.messages[1].content).toContain("帮我修构建");
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("returns nothing instead of failing when no auxiliary model is available", async () => {
    mocks.config.mockReturnValue(config({ inputOptimizationModel: "" }));
    await expect(
      suggestNextInput({ projectId: "p1", userRequest: "帮我修构建" }),
    ).resolves.toBe(null);
    expect(mocks.text).not.toHaveBeenCalled();
  });

  it("drops truncated and filtered answers", async () => {
    mocks.text.mockResolvedValue({ text: "运行", finishReason: "length" });
    await expect(
      suggestNextInput({ projectId: "p1", userRequest: "帮我修构建" }),
    ).resolves.toBe(null);

    mocks.text.mockResolvedValue({ text: "运行", finishReason: "content-filter" });
    await expect(
      suggestNextInput({ projectId: "p1", userRequest: "帮我修构建" }),
    ).resolves.toBe(null);
  });

  it("does not call the model without a request to answer", async () => {
    await expect(
      suggestNextInput({ projectId: "p1", userRequest: "   " }),
    ).resolves.toBe(null);
    expect(mocks.text).not.toHaveBeenCalled();
  });
});
