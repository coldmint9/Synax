import { logger } from "../../runtime/logger.js";
import type { ApiFormat } from "../../runtime/config/config-types.js";
import type { ResolvedProviderConfig, RuntimeProvider } from "../types.js";
import { isImageGenerationModel } from "../openai-models.js";
import { createRustLanguageModel } from "./rust-language-model.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RustProviderClient = {
  config: ResolvedProviderConfig;
  providerId: string;
  api: string | undefined;
  adapter?: string;
};
const SUPPORTED_ADAPTER_NAMES = new Set([
  "@ai-sdk/anthropic",
  "@ai-sdk/cerebras",
  "@ai-sdk/cohere",
  "@ai-sdk/deepinfra",
  "@ai-sdk/deepseek",
  "@ai-sdk/google",
  "@ai-sdk/groq",
  "@ai-sdk/mistral",
  "@ai-sdk/open-responses",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/perplexity",
  "@ai-sdk/togetherai",
  "@ai-sdk/xai",
  "@openrouter/ai-sdk-provider",
]);

export function isProviderSupported(
  provider: Pick<RuntimeProvider, "npm">,
): boolean {
  return Boolean(provider.npm && SUPPORTED_ADAPTER_NAMES.has(provider.npm));
}

export async function instantiateProvider(
  provider: Pick<RuntimeProvider, "id" | "label" | "npm" | "api"> & { env?: string[] },
  config: ResolvedProviderConfig,
): Promise<unknown> {
  if (!provider.npm) {
    throw new Error(
      `Provider '${provider.id}' is unsupported in Synax runtime`,
    );
  }

  const apiKey =
    config.apiKey ??
    (provider.env ?? []).map((name) => process.env[name]?.trim()).find(Boolean);
  const rustClient = {
    config: apiKey ? { ...config, apiKey } : config,
    providerId: config.providerId,
    api: config.baseUrl ?? provider.api,
    adapter: provider.npm,
  } satisfies RustProviderClient;

  // Keep the optional OpenAI media surface available for speech/transcription
  // and SDK image adapters. Conversation model selection below always uses
  // the Rust descriptor, so chat/responses/messages traffic stays in Rust.
  if (provider.npm === "@ai-sdk/openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const options = config.options && typeof config.options === "object"
      ? { ...(config.options as Record<string, unknown>) }
      : {};
    delete options.promptCaching;
    const headers = options.headers && typeof options.headers === "object"
      ? Object.fromEntries(
          Object.entries(options.headers as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
    delete options.headers;
    const mediaClient = createOpenAI({
      ...(rustClient.api ? { baseURL: rustClient.api } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(headers && Object.keys(headers).length ? { headers } : {}),
      ...options,
    });
    return Object.assign(mediaClient, rustClient);
  }
  return rustClient;
}

/**
 * Select the Rust-backed language model for a provider client.
 *
 * `apiFormat` pins the wire protocol of the connection:
 * - `openai` → Chat Completions (`.chat()` on the native OpenAI client, callable otherwise)
 * - `openai-responses` → Responses API (`.responses()`)
 * - `anthropic` → Messages API (`.messages()`)
 *
 * Without an explicit format the caller's resolved protocol defaults to
 * OpenAI Chat Completions.
 */
export function selectLanguageModel(
  client: unknown,
  modelId: string,
  modelOptions?: Record<string, unknown>,
  apiFormat?: ApiFormat,
): unknown {
  if (!client) throw new Error("Provider client was not created");
  if (isImageGenerationModel(modelId)) {
    throw new Error(
      `'${modelId}' is an image model. Select a conversation model and use media.generate with this image model.`,
    );
  }
  const rust = client as RustProviderClient;
  if (rust && (typeof rust === "object" || typeof rust === "function") && "config" in rust) {
    return createRustLanguageModel({
      providerId: rust.providerId,
      adapter: rust.adapter,
      apiFormat: apiFormat ?? rust.config.apiFormat ?? "openai",
      baseUrl: rust.config.baseUrl ?? rust.api,
      apiKey: rust.config.apiKey,
      options: rust.config.options,
    }, modelId);
  }
  const c = client as Record<string, unknown>;

  if (apiFormat === "openai-responses") {
    if (typeof c.responses === "function")
      return (c.responses as Function)(modelId, modelOptions);
    if (typeof client === "function")
      return (client as Function)(modelId, modelOptions);
    throw new Error(
      `Provider client cannot resolve Responses model '${modelId}': this connection has no Responses selector`,
    );
  }
  if (apiFormat === "openai" && typeof c.chat === "function") {
    return (c.chat as Function)(modelId, modelOptions);
  }
  if (apiFormat === "anthropic" && typeof c.messages === "function") {
    return (c.messages as Function)(modelId, modelOptions);
  }

  if (typeof client === "function")
    return (client as Function)(modelId, modelOptions);
  if (typeof c.responses === "function")
    return (c.responses as Function)(modelId, modelOptions);
  if (typeof c.messages === "function")
    return (c.messages as Function)(modelId, modelOptions);
  if (typeof c.chat === "function")
    return (c.chat as Function)(modelId, modelOptions);
  if (typeof c.languageModel === "function")
    return (c.languageModel as Function)(modelId, modelOptions);
  logger.warn(
    { modelId },
    "[llm-runtime] provider client has no language model selector",
  );
  throw new Error(`Provider client cannot resolve model '${modelId}'`);
}


/**
 * Adapter npm names the runtime can instantiate. The media capability table is
 * keyed by these names, and its coverage test walks this list so a new adapter
 * cannot ship without an explicit media declaration.
 */
export function registeredAdapterPackages(): string[] {
  return [...SUPPORTED_ADAPTER_NAMES].sort();
}
