import { expect, it } from "vitest";
import { outputProtocolOptions, publishedOutputLimits, resolveOutputReserve, withPublishedOutputLimits } from "../model-output-limits.js";
import type { ResolvedModelSelection, RuntimeModel } from "../types.js";
import { contextInputBudget } from "../../../modules/agent-runtime/context-checkpoint.js";

const model = (id: string, extra: Partial<RuntimeModel> = {}) => withPublishedOutputLimits({ id, label: id, ...extra });
function selection(id: string, apiFormat: ResolvedModelSelection["apiFormat"], baseUrl: string): ResolvedModelSelection {
  return { model: id, modelId: id, modelDef: model(id), apiFormat, providerId: "custom-api:test",
    provider: { id: "custom-api:test", label: "Test", env: [], supported: true, models: [] }, config: { providerId: "custom-api:test", baseUrl } };
}

it.each([
  ["gpt-6-astra", 128_000], ["gpt-6.1-sol", 128_000], ["claude-opus-5-5", 128_000],
  ["deepseek-flash", 393_216], ["deepseek-v4-flash", 393_216], ["gemini-4-argon", 65_536],
  ["qwen3.8-max", 131_072], ["kimi-k3.1-pro", 1_048_576], ["glm-5.3", 131_072],
])("fills documented synchronous limits for %s", (id, output) => {
  expect(model(id)).toMatchObject({ maxTokens: output, reasoning: true });
});

it("preserves explicit gateway limits and avoids guessing future or unrelated model names", () => {
  expect(model("deepseek-flash", { maxTokens: 32_768, contextLimit: 128_000, reasoning: false }))
    .toMatchObject({ maxTokens: 32_768, contextLimit: 128_000, reasoning: false });
  expect(model("deepseek/deepseek-flash-2026-10-19").maxTokens).toBe(393_216);
  for (const id of ["my-gpt-6-astra", "gemini-5", "qwen3.8-max-distilled", "private/deepseek-flash"])
    expect(publishedOutputLimits(id)).toBeUndefined();
});

it.each([["none", 8192], ["high", 65_536], ["max", 131_072]])("reserves DeepSeek %s defaults without confusing the 384K maximum", (effort, expected) => {
  expect(resolveOutputReserve(model("deepseek-v4-flash"), effort)).toBe(expected);
});

it("accounts for Qwen's separate answer/thinking allowances only when there is no explicit total cap", () => {
  const qwen = model("qwen3.8-max");
  expect(resolveOutputReserve(qwen, "none")).toBe(131_072);
  expect(resolveOutputReserve(qwen, "low")).toBe(135_168);
  expect(resolveOutputReserve(qwen, "medium")).toBe(147_456);
  expect(resolveOutputReserve(qwen, "high")).toBe(393_216);
  expect(resolveOutputReserve(qwen, "high", 4096)).toBe(4096);
});

it("uses Kimi's default instead of reserving its entire context window", () => {
  const kimi = model("kimi-k3.1-pro");
  const outputReserve = resolveOutputReserve(kimi, "high");
  expect(outputReserve).toBe(131_072);
  expect(contextInputBudget({ contextLimit: kimi.contextLimit!, outputReserve })).toBe(917_504);
});

it("keeps unknown reasoning budgets bounded and does not fabricate MiniMax maxima", () => {
  expect(model("MiniMax-M3.1-Flash").maxTokens).toBeUndefined();
  expect(resolveOutputReserve(model("MiniMax-M3.1-Flash"), "high")).toBe(65_536);
  expect(resolveOutputReserve(model("fixture", { reasoning: true, contextLimit: 32_768 }), "high")).toBe(8192);
  expect(resolveOutputReserve(model("fixture", { contextLimit: 4096 }), "none")).toBe(1024);
});

it("provides Claude's mandatory limit without adding a cap to optional protocols", () => {
  expect(outputProtocolOptions(selection("claude-fable-5-1", "anthropic", "https://api.anthropic.com"), "high"))
    .toEqual({ requiredMaxOutputTokens: 128_000 });
  for (const apiFormat of ["openai", "openai-responses"] as const)
    expect(outputProtocolOptions(selection("deepseek-flash", apiFormat, "https://api.deepseek.com"), "high")).toEqual({});
});

it.each([
  ["qwen3.8-max", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ["qwen3.8-flash", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
  ["qwen3.8-max", "https://cn-hangzhou.maas.aliyuncs.com/compatible-mode/v1"],
  ["kimi-k3.1-pro", "https://api.moonshot.ai/v1"],
  ["MiniMax-M3.1-Flash", "https://api.minimax.io/v1"],
])("selects total-output parameters for documented %s endpoints", (id, baseUrl) => {
  expect(outputProtocolOptions(selection(id, "openai", baseUrl))).toEqual({ outputTokenParameter: "max_completion_tokens" });
  expect(outputProtocolOptions(selection(id, "openai", "https://gateway.example/v1"))).toEqual({});
  expect(outputProtocolOptions(selection(id, "openai-responses", baseUrl))).toEqual({});
});
