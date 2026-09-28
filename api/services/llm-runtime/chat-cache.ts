import { createHash } from "node:crypto";
import type {
  LlmGatewayMessage,
  LlmGatewayRequest,
  ResolvedModelSelection,
} from "./types.js";
import { resolvePromptCaching } from "./cache-policy.js";

/** The key is a routing hint, NOT an authorization or conversation identifier. */
export function chatCacheOptions(
  selection: ResolvedModelSelection,
  request: LlmGatewayRequest,
): LlmGatewayRequest["providerOptions"] {
  if (
    selection.apiFormat !== "openai" ||
    request.cacheControl === false ||
    resolvePromptCaching(selection.config.options?.promptCaching) === "off"
  )
    return undefined;
  const native = selection.provider.npm === "@ai-sdk/openai";
  const compatible =
    selection.provider.npm === "@ai-sdk/openai-compatible" &&
    selection.config.options?.promptCaching === "on";
  if (!native && !compatible) return undefined;
  const namespace = native ? "openai" : selection.providerId;
  const field = native ? "promptCacheKey" : "prompt_cache_key";
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
