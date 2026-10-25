import type { ResolvedModelSelection, RuntimeModel } from "./types.js";

/** Published limits verified 2026-10-25. Capability limits are not request defaults.
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 * https://platform.claude.com/docs/en/about-claude/models/overview
 * https://api-docs.deepseek.com/api/create-chat-completion
 * https://ai.google.dev/gemini-api/docs/models/gemini-4-argon
 * https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
 * https://platform.kimi.ai/docs/api/chat
 * https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3
 * https://platform.minimax.io/docs/guides/models-intro
 */
interface PublishedLimits {
  context: number;
  output?: number;
  defaultOutput?: number;
  family: "openai" | "claude" | "deepseek" | "gemini" | "qwen" | "kimi" | "glm" | "minimax";
}

function modelName(id: string): string {
  return id.toLowerCase().replace(/^(?:openai|anthropic|deepseek|google|qwen|moonshotai|kimi|z-ai|zhipu|minimax)\//, "");
}

export function publishedOutputLimits(id: string): PublishedLimits | undefined {
  const name = modelName(id);
  const snapshot = name.replace(/-(?:20\d{2}-\d{2}-\d{2}|20\d{6}|\d{4})$/, "");
  if (["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"].includes(snapshot))
    return { family: "openai", context: 1_050_000, output: 128_000 };
  if (["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].includes(snapshot))
    return { family: "claude", context: 1_000_000, output: 128_000 };
  if (["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash", "deepseek-v4-pro"].includes(snapshot))
    return { family: "deepseek", context: 1_000_000, output: 393_216 };
  // Long decode is opt-in; synchronous requests do not inherit its 1M cap.
  if (snapshot === "gemini-4-argon")
    return { family: "gemini", context: 1_048_576, output: 65_536, defaultOutput: 65_536 };
  if (["qwen3.8-max", "qwen3.8-flash", "qwen3.8-27b"].includes(snapshot))
    return { family: "qwen", context: 1_000_000, output: 131_072 };
  if (["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3"].includes(snapshot))
    return { family: "kimi", context: 1_048_576, output: 1_048_576, defaultOutput: 131_072 };
  if (["glm-5.3", "glm-5.2"].includes(snapshot))
    return { family: "glm", context: 1_000_000, output: 131_072 };
  // Current MiniMax docs establish context/reasoning, but not an output maximum.
  if (["minimax-m3.1-flash", "minimax-m3"].includes(snapshot))
    return { family: "minimax", context: 1_000_000 };
}

/** Catalog/configured values win; a documented fallback only fills missing facts. */
export function withPublishedOutputLimits(model: RuntimeModel): RuntimeModel {
  const limits = publishedOutputLimits(model.id);
  if (!limits) return model;
  return { ...model, contextLimit: model.contextLimit ?? limits.context,
    maxTokens: model.maxTokens ?? limits.output, reasoning: model.reasoning ?? true };
}

function hostname(selection: ResolvedModelSelection): string {
  try { return new URL(selection.config.baseUrl ?? selection.provider.api ?? "").hostname.toLowerCase(); }
  catch { return ""; }
}

function isDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Local context reservation; never an implicit cap on an optional wire field. */
export function resolveOutputReserve(model: RuntimeModel, effort?: string, explicitLimit?: number): number {
  if (explicitLimit !== undefined) return explicitLimit;
  const limits = publishedOutputLimits(model.id);
  const context = model.contextLimit ?? limits?.context ?? 200_000;
  const output = model.maxTokens ?? limits?.output;
  const thinking = effort !== "none" && (model.reasoning ?? Boolean(limits));
  let reserve: number;
  if (limits?.family === "deepseek") reserve = !thinking ? 8192 : effort === "max" ? 131_072 : 65_536;
  else if (limits?.family === "qwen") {
    // The legacy default covers the answer; thinking has a separate allowance.
    const thought = !thinking ? 0 : effort === "low" ? 4096 : effort === "medium" ? 16_384 : 262_144;
    reserve = (output ?? 131_072) + thought;
  } else reserve = limits?.defaultOutput ?? output ?? (thinking ? 65_536 : 8192);
  if (output !== undefined && limits?.family !== "qwen") reserve = Math.min(reserve, output);
  // Unknown/overridden small windows must retain input space. Explicit limits
  // remain subject to contextInputBudget validation instead of silent clipping.
  return reserve < context ? reserve : Math.max(1, Math.min(thinking ? 65_536 : 8192, Math.floor(context / 4)));
}

export function outputProtocolOptions(selection: ResolvedModelSelection, effort?: string): {
  requiredMaxOutputTokens?: number;
  outputTokenParameter?: "max_completion_tokens";
} {
  const model = selection.modelDef;
  if (selection.apiFormat === "anthropic") {
    const reserve = resolveOutputReserve(model, effort);
    return { requiredMaxOutputTokens: Math.min(reserve, model.maxTokens ?? reserve) };
  }
  if (selection.apiFormat !== "openai") return {};
  const host = hostname(selection);
  const family = publishedOutputLimits(model.id)?.family;
  const moonshot = ["moonshot.ai", "moonshot.cn", "kimi.ai"].some(domain => isDomain(host, domain));
  const dashscope = host === "dashscope.aliyuncs.com" || /^dashscope-[a-z0-9-]+\.aliyuncs\.com$/.test(host)
    || isDomain(host, "maas.aliyuncs.com");
  const minimax = ["minimax.io", "minimaxi.com"].some(domain => isDomain(host, domain));
  if ((family === "kimi" && moonshot) || (family === "minimax" && minimax) ||
      (dashscope && ["qwen", "kimi", "glm", "deepseek", "minimax"].includes(family ?? "")))
    return { outputTokenParameter: "max_completion_tokens" };
  return {};
}
