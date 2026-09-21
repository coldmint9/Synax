import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { ThinkingMode } from "../agent-runtime/contracts.js";
import {
  buildOpenAICompatibleProviderOptions,
  isOpenAICompatibleProvider,
  mergeProviderOptions,
  resolveProviderOptionsNamespace,
} from "./custom-api-compat.js";
import type { LlmGatewayRequest, ResolvedModelSelection } from "./types.js";
import { openAIModelContract } from "./openai-models.js";

export type ReasoningEffort = NonNullable<LlmGatewayRequest["reasoningEffort"]>;

/** Per-request LLM call overrides derived from a thinking-mode strategy. */
export interface ThinkingStreamOptions {
  providerOptions?: SharedV3ProviderOptions;
  temperature?: number;
}

/** Minimal provider context used to pick a thinking-mode strategy. */
export interface ThinkingModeContext {
  providerId: string;
  baseUrl?: string;
  npm?: string;
  /** Catalog / runtime model capability flag. */
  reasoning?: boolean;
}

export interface ThinkingModeStrategy {
  readonly id: string;
  matches(ctx: ThinkingModeContext): boolean;
  /**
   * When set, official endpoints may use a native SDK instead of openai-compatible.
   * Custom/proxy base URLs stay on openai-compatible with providerOptions passthrough.
   */
  preferredAdapter?: {
    npm: string;
    api: string;
    env: string[];
    /** Only upgrade when base URL matches (official API). */
    officialBaseUrl?: string;
  };
  defaultReasoningCapability: boolean;
  buildStreamOptions(
    ctx: ThinkingModeContext,
    request: Pick<
      LlmGatewayRequest,
      "reasoningEffort" | "responseOptions" | "temperature"
    >,
    selection: ResolvedModelSelection,
  ): ThinkingStreamOptions;
}

export function mapThinkingModeToReasoningEffort(
  mode: ThinkingMode | undefined,
): ReasoningEffort {
  return mode === "deep" ? "max" : "high";
}

function hostIncludes(baseUrl: string | undefined, fragment: string): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const host = new URL(baseUrl.replace(/\/$/, "")).hostname.toLowerCase();
    return host.includes(fragment.toLowerCase());
  } catch {
    return baseUrl.toLowerCase().includes(fragment.toLowerCase());
  }
}

function isOfficialDeepSeekBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const host = new URL(baseUrl.replace(/\/$/, "")).hostname.toLowerCase();
    return host === "api.deepseek.com";
  } catch {
    return false;
  }
}

function providerIdIncludes(providerId: string, fragment: string): boolean {
  return providerId.toLowerCase().includes(fragment.toLowerCase());
}

function toContext(selection: ResolvedModelSelection): ThinkingModeContext {
  return {
    providerId: selection.providerId,
    baseUrl: selection.config.baseUrl ?? selection.provider.api,
    npm: selection.provider.npm,
    reasoning: selection.modelDef.reasoning,
  };
}

function toContextFromConnection(
  providerId: string,
  baseUrl?: string,
): ThinkingModeContext {
  return { providerId, baseUrl };
}

function buildDeepSeekThinkingOptions(
  selection: ResolvedModelSelection,
  request: Pick<
    LlmGatewayRequest,
    "reasoningEffort" | "responseOptions" | "temperature"
  >,
): ThinkingStreamOptions {
  const effort = request.reasoningEffort ?? "high";
  // A DeepSeek connection explicitly configured as Responses is handled by
  // the native OpenAI Responses adapter, not by DeepSeek's Chat Completions
  // body fields. Keep the reasoning control in the OpenAI namespace.
  if (selection.apiFormat === "openai-responses") {
    // The Responses adapter logs an AI SDK warning for reasoning options sent
    // to a model it does not classify as reasoning (custom/gateway IDs such as
    // deepseek-v4-flash are unknown to it). Without a reasoning-capable flag
    // the options are ignored anyway, so keep the call plain.
    const reasoningCapable = Boolean(
      request.responseOptions?.forceReasoning ?? selection.modelDef.reasoning,
    );
    if (!reasoningCapable) {
      return { temperature: request.temperature };
    }
    return {
      providerOptions: {
        openai: {
          reasoningEffort: effort,
        },
      },
      temperature: undefined,
    };
  }

  // Native @ai-sdk/deepseek — providerOptions.deepseek (camelCase reasoningEffort)
  if (selection.provider.npm === "@ai-sdk/deepseek") {
    return {
      providerOptions: {
        deepseek: {
          thinking: { type: "enabled" },
          reasoningEffort: effort,
        },
      },
      temperature: undefined,
    };
  }

  // AI SDK v6 openai-compatible — providerOptions[providerId] merges into request body
  const namespace = resolveProviderOptionsNamespace(selection);
  return {
    providerOptions: mergeProviderOptions(
      buildOpenAICompatibleProviderOptions(namespace, {
        thinking: { type: "enabled" },
        reasoning_effort: effort,
      }),
      {
        openaiCompatible: {
          reasoningEffort: effort,
        },
      },
    ),
    temperature: undefined,
  };
}

/**
 * Thinking-disabled provider options for utility calls (session titles,
 * context signals, validation probes).
 *
 * Reasoning-first models otherwise spend the entire output budget on hidden
 * reasoning tokens and return empty text: a 128-token title call finished with
 * `finishReason: "length"`, 128 reasoning tokens and zero text tokens, which
 * silently degraded every generated session title to the raw-prompt fallback.
 */
export function buildThinkingDisabledOptions(
  selection: ResolvedModelSelection,
  temperature?: number,
): ThinkingStreamOptions {
  if (
    openAIModelContract(selection.modelId)?.reasoning &&
    ["@ai-sdk/openai", "@ai-sdk/openai-compatible"].includes(
      selection.provider.npm ?? "",
    )
  ) {
    return {
      providerOptions: { openai: { reasoningEffort: "none" } },
      temperature,
    };
  }
  // Only DeepSeek-shaped providers expose an explicit `thinking` toggle here;
  // other providers keep their previous behavior (no thinking options at all)
  // so unknown request-body fields are never sent to them.
  const strategy = resolveThinkingModeStrategy(toContext(selection));
  if (strategy?.id !== "deepseek") return { temperature };

  if (selection.provider.npm === "@ai-sdk/deepseek") {
    return {
      providerOptions: { deepseek: { thinking: { type: "disabled" } } },
      temperature,
    };
  }

  if (!isOpenAICompatibleProvider(selection.provider.npm)) {
    return { temperature };
  }

  const namespace = resolveProviderOptionsNamespace(selection);
  return {
    providerOptions: mergeProviderOptions(
      buildOpenAICompatibleProviderOptions(namespace, {
        thinking: { type: "disabled" },
      }),
    ),
    temperature,
  };
}

const deepSeekThinkingStrategy: ThinkingModeStrategy = {
  id: "deepseek",
  preferredAdapter: {
    npm: "@ai-sdk/deepseek",
    api: "https://api.deepseek.com",
    env: ["DEEPSEEK_API_KEY"],
    officialBaseUrl: "https://api.deepseek.com",
  },
  defaultReasoningCapability: true,
  matches(ctx) {
    return (
      ctx.npm === "@ai-sdk/deepseek" ||
      hostIncludes(ctx.baseUrl, "deepseek.com") ||
      providerIdIncludes(ctx.providerId, "deepseek")
    );
  },
  buildStreamOptions(_ctx, request, selection) {
    return buildDeepSeekThinkingOptions(selection, request);
  },
};

const nativeReasoningModelStrategy: ThinkingModeStrategy = {
  id: "native-reasoning-model",
  defaultReasoningCapability: true,
  matches(ctx) {
    if (!ctx.reasoning) return false;
    if (deepSeekThinkingStrategy.matches(ctx)) return false;
    return (
      ctx.npm === "@ai-sdk/google" ||
      ctx.npm === "@ai-sdk/anthropic" ||
      ctx.npm === "@ai-sdk/openai" ||
      ctx.npm === "@ai-sdk/openai-compatible" ||
      ctx.npm === "@ai-sdk/xai"
    );
  },
  buildStreamOptions(_ctx, request, selection) {
    const namespace = resolveProviderOptionsNamespace(selection);
    const effort = request.reasoningEffort;
    if (effort && isOpenAICompatibleProvider(selection.provider.npm)) {
      return {
        providerOptions: mergeProviderOptions(
          buildOpenAICompatibleProviderOptions(namespace, {
            reasoning_effort: effort,
          }),
          { openaiCompatible: { reasoningEffort: effort } },
        ),
        temperature: request.temperature,
      };
    }
    return { temperature: request.temperature };
  },
};

const THINKING_MODE_STRATEGIES: ThinkingModeStrategy[] = [
  deepSeekThinkingStrategy,
  nativeReasoningModelStrategy,
];

export function resolveThinkingModeStrategy(
  ctx: ThinkingModeContext,
): ThinkingModeStrategy | null {
  return (
    THINKING_MODE_STRATEGIES.find((strategy) => strategy.matches(ctx)) ?? null
  );
}

export function buildThinkingStreamOptions(
  selection: ResolvedModelSelection,
  request: Pick<
    LlmGatewayRequest,
    "reasoningEffort" | "responseOptions" | "temperature"
  >,
): ThinkingStreamOptions {
  if (
    selection.provider.npm === "@ai-sdk/openai" &&
    openAIModelContract(selection.modelId)?.reasoning
  ) {
    const effort = request.reasoningEffort ?? "medium";
    return {
      providerOptions: { openai: { reasoningEffort: effort } },
      temperature: effort === "none" ? request.temperature : undefined,
    };
  }
  const strategy = resolveThinkingModeStrategy(toContext(selection));
  if (!strategy) {
    return { temperature: request.temperature };
  }
  return strategy.buildStreamOptions(toContext(selection), request, selection);
}

/**
 * Prefer native SDK only for official API endpoints; custom/proxy URLs keep
 * openai-compatible with providerOptions passthrough (AI SDK v6).
 */
export function resolvePreferredProviderAdapter(input: {
  providerId: string;
  baseUrl?: string;
}): ThinkingModeStrategy["preferredAdapter"] | undefined {
  const strategy = resolveThinkingModeStrategy(
    toContextFromConnection(input.providerId, input.baseUrl),
  );
  const adapter = strategy?.preferredAdapter;
  if (!adapter) return undefined;
  if (adapter.officialBaseUrl && !isOfficialDeepSeekBaseUrl(input.baseUrl)) {
    return undefined;
  }
  return adapter;
}

export function inferReasoningCapability(ctx: ThinkingModeContext): boolean {
  if (ctx.reasoning) return true;
  const strategy = resolveThinkingModeStrategy(ctx);
  return strategy?.defaultReasoningCapability ?? false;
}

/** @deprecated Use resolveThinkingModeStrategy. */
export function isDeepSeekHost(baseUrl?: string): boolean {
  return deepSeekThinkingStrategy.matches({ providerId: "", baseUrl });
}

/** @deprecated Use resolveThinkingModeStrategy. */
export function isDeepSeekProviderId(providerId: string): boolean {
  return deepSeekThinkingStrategy.matches({ providerId });
}

/** @deprecated Use resolveThinkingModeStrategy(toContext(selection)). */
export function isDeepSeekSelection(
  selection: ResolvedModelSelection,
): boolean {
  return deepSeekThinkingStrategy.matches(toContext(selection));
}
