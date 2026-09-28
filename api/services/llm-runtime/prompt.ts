import type { ModelMessage, SystemModelMessage } from "@ai-sdk/provider-utils";
import type { LlmGatewayRequest } from "./types.js";

const RUNTIME_REMINDER_RE = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

const JSON_OBJECT_RESPONSE_FORMAT_INSTRUCTION =
  "Return only valid json that matches the requested schema.";

export function toModelPrompt(
  messages: LlmGatewayRequest["messages"],
  cacheControl?: boolean,
  options: { moveRuntimeRemindersToInput?: boolean } = {},
): { system?: string | SystemModelMessage[]; messages: ModelMessage[] } {
  // Keep blocks separate: joining or trimming loses per-block metadata and bytes.
  const system = messages
    .filter(
      (message): message is SystemModelMessage =>
        message.role === "system" &&
        !(options.moveRuntimeRemindersToInput && isRuntimeReminder(message)),
    )
    .map((message) => ({
      ...message,
      providerOptions: copyProviderOptions(message.providerOptions),
    }));

  // Compatibility for callers not yet using the connection-aware cache policy.
  // Policy-aware callers must omit this flag; their marker budget includes tools/history.
  if (cacheControl && system.length > 0) {
    const last = system[system.length - 1];
    last.providerOptions = {
      ...last.providerOptions,
      anthropic: {
        ...last.providerOptions?.anthropic,
        cacheControl: { type: "ephemeral" },
      },
    };
  }

  const conversation: ModelMessage[] = messages.flatMap((message): ModelMessage[] => {
    if (message.role === "system" && options.moveRuntimeRemindersToInput) {
      const content = typeof message.content === "string" ? message.content : "";
      if (RUNTIME_REMINDER_RE.test(content)) {
        // Chat/Responses providers cache ordered prefixes. Runtime state changes
        // every step, so keep it in the input tail instead of invalidating
        // the stable system prefix.
        return [{ ...message, role: "user" as const }];
      }
    }
    return isConversationMessage(message) ? [message] : [];
  });

  return {
    ...(system.length > 0 ? { system } : {}),
    messages: toModelMessages(conversation),
  };
}

export function ensureJsonObjectResponseFormatInstruction(
  messages: LlmGatewayRequest["messages"],
): LlmGatewayRequest["messages"] {
  if (
    messages.some((message) => contentContainsLowercaseJson(message.content))
  ) {
    return messages;
  }

  const lastSystemIndex = messages.findLastIndex(
    (message) => message.role === "system",
  );
  if (lastSystemIndex >= 0) {
    return messages.map((message, index) => {
      if (index !== lastSystemIndex || message.role !== "system")
        return message;
      return {
        ...message,
        content: `${message.content.trim()}\n\n${JSON_OBJECT_RESPONSE_FORMAT_INSTRUCTION}`,
      };
    });
  }

  return [
    { role: "system", content: JSON_OBJECT_RESPONSE_FORMAT_INSTRUCTION },
    ...messages,
  ];
}

function isRuntimeReminder(
  message: LlmGatewayRequest["messages"][number],
): boolean {
  return (
    message.role === "system" &&
    typeof message.content === "string" &&
    RUNTIME_REMINDER_RE.test(message.content)
  );
}

function isConversationMessage(
  message: LlmGatewayRequest["messages"][number],
): message is LlmGatewayRequest["messages"][number] & {
  role: "user" | "assistant" | "tool";
} {
  return message.role !== "system";
}

function toModelMessages(
  messages: ModelMessage[],
): ModelMessage[] {
  return messages.map((message) => ({
    ...message,
    providerOptions: copyProviderOptions(message.providerOptions),
    ...(Array.isArray(message.content)
      ? {
          content: message.content.map((part) => ({
            ...part,
            providerOptions: copyProviderOptions(
              "providerOptions" in part ? part.providerOptions : undefined,
            ),
          })),
        }
      : {}),
  })) as ModelMessage[];
}

function copyProviderOptions(
  options: ModelMessage["providerOptions"],
): ModelMessage["providerOptions"] {
  return (
    options &&
    Object.fromEntries(
      Object.entries(options).map(([key, value]) => [key, { ...value }]),
    )
  );
}

function contentContainsLowercaseJson(value: unknown): boolean {
  if (typeof value === "string") return /\bjson\b/.test(value);
  if (Array.isArray(value))
    return value.some((item) => contentContainsLowercaseJson(item));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      contentContainsLowercaseJson(item),
    );
  }
  return false;
}
