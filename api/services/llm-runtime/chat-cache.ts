import { createHash } from "node:crypto";
import type {
  LlmGatewayMessage,
  LlmGatewayRequest,
  ResolvedModelSelection,
} from "./types.js";
import { resolvePromptCaching } from "./cache-policy.js";
import { normalizeProviderOptionsNamespace } from "./custom-api-compat.js";

/** Where a Chat Completions cache hint can physically reach the wire. */
export interface PromptCacheCapability {
  /** providerOptions namespace the adapter actually reads. */
  namespace: string;
  field: "promptCacheKey" | "prompt_cache_key";
  /** Native schema-validated field vs. body passthrough on a compatible SDK. */
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
export function describeChatCacheHint(
  selection: ResolvedModelSelection,
  request: LlmGatewayRequest,
): {
  kind: "native-key" | "passthrough-key" | "none";
  namespace?: string;
  field?: string;
  valueHash?: string;
} {
  const capability = resolvePromptCacheCapability(selection);
  const options = chatCacheOptions(selection, request) as
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
export function chatCacheOptions(
  selection: ResolvedModelSelection,
  request: LlmGatewayRequest,
): LlmGatewayRequest["providerOptions"] {
  if (
    request.cacheControl === false ||
    resolvePromptCaching(selection.config.options?.promptCaching) === "off"
  )
    return undefined;
  const capability = resolvePromptCacheCapability(selection);
  if (!capability) return undefined;
  const { namespace, field } = capability;
  // User overrides win, including provider-native overrides on the connection.
  const explicit =
    request.responseOptions?.promptCacheKey ??
    request.providerOptions?.[namespace]?.[field] ??
    (selection.config.options?.providerOptions as LlmGatewayRequest["providerOptions"])?.[
      namespace
    ]?.[field];
  if (typeof explicit === "string") return { [namespace]: { [field]: explicit } };
  const sessionId = request.hookContext?.sessionId;
  if (!sessionId) return undefined;
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        "synax-chat-v1",
        selection.providerId,
        selection.config.baseUrl ?? selection.provider.api,
        selection.modelId,
        request.projectId ?? null,
        sessionId,
      ]),
    )
    .digest("hex")
    .slice(0, 40);
  return { [namespace]: { [field]: `synax:chat:v1:${key}` } };
}

/** Only a declared endpoint capability enables explicit blocks. An SDK exposing
 * this option does not mean older models or custom endpoints accept the field.
 * Compatible SDKs cannot serialize these per-content markers faithfully. */
export function applyChatCacheBreakpoints(
  messages: LlmGatewayMessage[],
  selection: ResolvedModelSelection,
  request: Pick<LlmGatewayRequest, "cacheControl">,
): LlmGatewayMessage[] {
  if (
    selection.apiFormat !== "openai" ||
    selection.provider.npm !== "@ai-sdk/openai" ||
    selection.config.options?.chatCacheBreakpoints === false ||
    request.cacheControl === false ||
    resolvePromptCaching(selection.config.options?.promptCaching) === "off"
  )
    return messages;
  const reminder = (m: LlmGatewayMessage) =>
    typeof m.content === "string" &&
    /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(
      m.content,
    );
  const staticSystem = messages.findLastIndex(m => m.role === "system" && !reminder(m));
  const tail = messages.findLastIndex(reminder);
  const boundary = tail >= 0 ? tail : messages.findLastIndex(m => m.role === "user");
  // Never mark the changing reminder, thinking/signatures or partial tool inputs.
  const mark = (options: LlmGatewayMessage["providerOptions"]) => ({
    ...options,
    openai: {
      ...options?.openai,
      promptCacheBreakpoint: { mode: "explicit" },
    },
  });
  let markedHistory = false;
  return messages
    .toReversed()
    .map((m, reverseIndex): LlmGatewayMessage => {
      const index = messages.length - 1 - reverseIndex;
      if (index === staticSystem)
        return { ...m, providerOptions: mark(m.providerOptions) };
      if (
        markedHistory ||
        index >= boundary ||
        m.role === "system" ||
        reminder(m)
      )
        return m;
      if (typeof m.content === "string") {
        if (!m.content) return m;
        markedHistory = true;
        return {
          ...m,
          content: [
            { type: "text", text: m.content, providerOptions: mark(undefined) },
          ],
        } as LlmGatewayMessage;
      }
      const end = m.content.findLastIndex(
        (p) => (p.type === "text" && !!p.text) || p.type === "tool-result",
      );
      if (end < 0) return m;
      markedHistory = true;
      return {
        ...m,
        content: m.content.map((p, i) =>
          i === end
            ? {
                ...p,
                providerOptions: mark(
                  "providerOptions" in p ? p.providerOptions : undefined,
                ),
              }
            : p,
        ),
      } as LlmGatewayMessage;
    })
    .toReversed();
}
