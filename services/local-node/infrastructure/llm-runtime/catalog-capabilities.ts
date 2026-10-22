/** Saved model-catalog identifiers only. Node never loads these packages. */
import type { RuntimeProvider } from "./types.js";
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

export function supportedCatalogAdapters(): string[] {
  return [...SUPPORTED_ADAPTER_NAMES].sort();
}
