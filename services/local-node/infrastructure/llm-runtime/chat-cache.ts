import { createHash } from "node:crypto";
import type {
  LlmGatewayMessage,
  LlmGatewayRequest,
  ResolvedModelSelection,
} from "./types.js";
import { applyPromptCachePolicy, resolvePromptCaching } from "./cache-policy.js";
import { prepareProvider } from "./native-client.js";
import { mergeProviderOptions } from "./connection-options.js";
import { normalizeProviderOptionsNamespace } from "./connection-options.js";

/** Where a Chat Completions cache hint can physically reach the wire. */
export interface PromptCacheCapability {
  /** providerOptions namespace the adapter actually reads. */
  namespace: string;
  field: "promptCacheKey" | "prompt_cache_key";
  /** Named protocol option vs. a saved compatible-provider body field. */
  native: boolean;
}

/**
 * Capability matrix for Chat Completions cache hints.
 *
 * `auto` (the default) sends the hint whenever a carrier exists, so no model is
 * excluded by provider identity. Adapters outside this matrix never receive an
 * invented field: only user-supplied providerOptions pass through for them.
 */
export function resolvePromptCacheCapability(
  selection: ResolvedModelSelection,
): PromptCacheCapability | undefined {
  if (selection.apiFormat !== "openai") return undefined;
  if (selection.provider.npm === "@ai-sdk/openai")
    return { namespace: "openai", field: "promptCacheKey", native: true };
  if (selection.provider.npm === "@ai-sdk/openai-compatible")
    return {
      namespace: normalizeProviderOptionsNamespace(selection.providerId),
      field: "prompt_cache_key",
      native: false,
    };
  return undefined;
}

/**
 * Adapters whose wire format expects strictly alternating roles. The volatile
 * runtime tail is merged into the preceding user turn for these instead of
 * emitting a second consecutive user message.
 *
 * Anthropic is deliberately excluded: its SDK already combines same-role turns,
 * and merging would place the changing reminder inside the message that carries
 * the history cache marker, which is exactly what the tail placement avoids.
 */
const STRICT_ALTERNATION_ADAPTERS = new Set([
  "@ai-sdk/mistral",
  "@ai-sdk/cohere",
]);

export function requiresStrictAlternation(
  selection: ResolvedModelSelection,
): boolean {
  return STRICT_ALTERNATION_ADAPTERS.has(selection.provider.npm ?? "");
}

/**
 * Body-free report of the hint this request actually carries, derived from the
 * same call that produces it so the two can never drift. Only a fingerprint of
 * the key leaves this function; prompt bodies never do.
 */
export async function describeChatCacheHint(
  selection: ResolvedModelSelection,
  request: LlmGatewayRequest,
): Promise<{
  kind: "native-key" | "passthrough-key" | "none";
  namespace?: string;
  field?: string;
  valueHash?: string;
}> {
  const capability = resolvePromptCacheCapability(selection);
  const options = await chatCacheOptions(selection, request) as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!capability || !options) return { kind: "none" };
  const value = options[capability.namespace]?.[capability.field];
  return {
    kind: capability.native ? "native-key" : "passthrough-key",
    namespace: capability.namespace,
    field: capability.field,
    ...(typeof value === "string"
      ? {
          valueHash: createHash("sha256").update(value).digest("hex").slice(0, 16),
        }
      : {}),
  };
}

/** The key is a routing hint, NOT an authorization or conversation identifier. */
export async function chatCacheOptions(selection: ResolvedModelSelection, request: LlmGatewayRequest): Promise<LlmGatewayRequest["providerOptions"]> {
  const capability = resolvePromptCacheCapability(selection);
  if (!capability) return undefined;
  const prepared = await prepareProvider({ apiFormat: selection.apiFormat, providerId: selection.providerId, model: selection.modelId,
    baseUrl: selection.config.baseUrl ?? selection.provider.api, prompt: [],
    providerOptions: mergeProviderOptions(selection.config.options?.providerOptions as LlmGatewayRequest["providerOptions"], request.providerOptions),
    responseOptions: request.responseOptions as Record<string, unknown>,
    cachePolicy: { adapter: selection.provider.npm, enabled: request.cacheControl, mode: resolvePromptCaching(selection.config.options?.promptCaching),
      sessionId: request.hookContext?.sessionId, projectId: request.projectId } });
  if (request.cacheControl === false || selection.config.options?.promptCaching === "off") return undefined;
  const value = prepared.providerOptions?.[capability.namespace]?.[capability.field];
  return typeof value === "string" ? { [capability.namespace]: { [capability.field]: value } } : undefined;
}

/** Inspect native cache annotations; all allocation is performed by Rust. */
export async function applyChatCacheBreakpoints(messages: LlmGatewayMessage[], selection: ResolvedModelSelection, request: Pick<LlmGatewayRequest, "cacheControl">): Promise<LlmGatewayMessage[]> {
  return (await applyPromptCachePolicy(messages, { selection, cacheControl: request.cacheControl })).messages;
}
