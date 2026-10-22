import type { ThinkingMode } from "../../modules/agent-runtime/contracts.js";
import type { LlmGatewayRequest } from "./types.js";

export type ReasoningEffort = NonNullable<LlmGatewayRequest["reasoningEffort"]>;

/** Host UI/catalog metadata only. Native request controls are resolved in Rust. */
export function mapThinkingModeToReasoningEffort(mode: ThinkingMode | undefined): NonNullable<LlmGatewayRequest["reasoningEffort"]> {
  return mode === "deep" ? "max" : "high";
}
export function inferReasoningCapability(input: { providerId: string; baseUrl?: string; npm?: string; reasoning?: boolean }): boolean {
  return Boolean(input.reasoning || input.npm === "@ai-sdk/deepseek" || input.providerId.toLowerCase().includes("deepseek") || host(input.baseUrl).endsWith("deepseek.com"));
}
export function resolvePreferredProviderAdapter(input: { providerId: string; baseUrl?: string }) {
  if (host(input.baseUrl) !== "api.deepseek.com") return undefined;
  // Keep saved catalog identifiers compatible; this does not instantiate an SDK.
  return { npm: "@ai-sdk/deepseek", api: "https://api.deepseek.com", env: ["DEEPSEEK_API_KEY"], officialBaseUrl: "https://api.deepseek.com" };
}
function host(baseUrl?: string): string {
  try { return baseUrl ? new URL(baseUrl).hostname.toLowerCase() : ""; } catch { return ""; }
}
