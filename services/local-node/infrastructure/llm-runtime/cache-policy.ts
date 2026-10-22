import { createHash } from "node:crypto";
import type { ModelMessage } from "./contracts.js";
import type { ToolSet } from "./contracts.js";
import type { LlmGatewayMessage, ResolvedModelSelection } from "./types.js";

type ProviderOptions = ModelMessage["providerOptions"];
type ContentPart = Exclude<LlmGatewayMessage["content"], string>[number];

export interface HistoryCacheAnchor {
  version: 1;
  fingerprint: string;
}
type MetadataCarrier = { providerOptions?: ProviderOptions };

export type PromptCaching = "auto" | "on" | "off";

/** Connection-only setting, never a model-level provider option. */
export function resolvePromptCaching(value: unknown): PromptCaching {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "on" || value === "off") return value;
  throw new Error("options.promptCaching must be auto, on, or off");
}

export interface PromptCachePolicyOptions {
  selection: ResolvedModelSelection;
  cacheControl?: boolean;
  tools?: ToolSet;
  previousHistoryAnchor?: HistoryCacheAnchor;
  /** Original gateway message indices, when reminders do not use the Native wrapper. */
  runtimeReminderIndices?: readonly number[];
}

export interface PromptCachePolicyResult {
  messages: LlmGatewayMessage[];
  tools?: ToolSet;
}

/** Only remove cache controls, never signatures, citations, or other providers' metadata. */
function withoutCache(options: ProviderOptions): ProviderOptions {
  if (!options) return options;
  return Object.fromEntries(
    Object.entries(options).map(([provider, values]) => {
      const copied = { ...values };
      if (provider === "anthropic") {
        delete copied.cacheControl;
        delete copied.cache_control;
      }
      return [provider, copied];
    }),
  );
}

function isRuntimeReminder(message: LlmGatewayMessage): boolean {
  // Legacy snapshots used user; new snapshots carry runtime state as system.
  if (message.role !== "user" && message.role !== "system") return false;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.length === 1 && message.content[0].type === "text"
        ? message.content[0].text
        : "";
  return /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(text);
}

function copyPartWithoutCache(
  part: ContentPart,
): ContentPart & MetadataCarrier {
  const target = {
    ...part,
    providerOptions: withoutCache(
      "providerOptions" in part ? part.providerOptions : undefined,
    ),
  };
  if (part.type === "tool-result" && target.type === "tool-result") {
    const output = part.output;
    target.output =
      output.type === "content"
        ? {
            ...output,
            value: output.value.map((item) => ({
              ...item,
              providerOptions: withoutCache(item.providerOptions),
            })),
          }
        : {
            ...output,
            ...("providerOptions" in output
              ? { providerOptions: withoutCache(output.providerOptions) }
              : {}),
          };
  }
  return target;
}

function isEligiblePart(
  part: ContentPart,
  role: LlmGatewayMessage["role"],
): boolean {
  return (
    (part.type === "text" && part.text.length > 0) ||
    (role === "user" && (part.type === "image" || part.type === "file")) ||
    ((part.type === "tool-call" || part.type === "tool-result") &&
      !("providerExecuted" in part && part.providerExecuted))
  );
}

function latestReminderIndex(messages: readonly LlmGatewayMessage[]): number {
  const reminder = messages.findLastIndex(isRuntimeReminder);
  return reminder >= 0
    ? reminder
    : messages.findLastIndex((message) => message.role === "user");
}

// Canonical typed serialization keeps URL/binary contents and distinguishes them
// from look-alike JSON tool data. Empty metadata namespaces are semantically absent.
function canonicalize(value: unknown): unknown {
  if (value instanceof URL) return ["url", value.href];
  if (value instanceof ArrayBuffer)
    return ["bytes", Buffer.from(value).toString("base64")];
  if (ArrayBuffer.isView(value))
    return [
      "bytes",
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
        "base64",
      ),
    ];
  if (Array.isArray(value)) return ["array", value.map(canonicalize)];
  if (!value || typeof value !== "object") return value;
  return [
    "object",
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonicalize(item)]),
  ];
}

function fingerprintMetadata(options: ProviderOptions): ProviderOptions {
  const entries = Object.entries(withoutCache(options) ?? {})
    .map(
      ([provider, values]) =>
        [
          provider,
          Object.fromEntries(
            Object.entries(values).filter(([, value]) => value !== undefined),
          ),
        ] as const,
    )
    .filter(([, values]) => Object.keys(values).length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Hash the marker-free message prefix through the eligible historical end.
 * Persist this alongside the exact reminder; pass it back as previousHistoryAnchor
 * on the next request. Omitted index uses the latest Native reminder, or the latest
 * user input for non-Native callers. No prompt body escapes this synchronous helper.
 */
export function createHistoryCacheAnchor(
  messages: readonly LlmGatewayMessage[],
  beforeReminderIndex: number = latestReminderIndex(messages),
): HistoryCacheAnchor {
  if (
    !Number.isInteger(beforeReminderIndex) ||
    beforeReminderIndex < -1 ||
    beforeReminderIndex > messages.length
  ) {
    throw new Error("beforeReminderIndex must be a message boundary index");
  }
  let end = -1;
  let partEnd: number | undefined;
  for (let index = 0; index < beforeReminderIndex; index++) {
    const message = messages[index];
    if (message.role === "system") continue;
    if (typeof message.content === "string") {
      if (message.content.length > 0) {
        end = index;
        partEnd = undefined;
      }
    } else {
      const part = message.content.findLastIndex((item) =>
        isEligiblePart(item, message.role),
      );
      if (part >= 0) {
        end = index;
        partEnd = part;
      }
    }
  }
  const prefix = messages.slice(0, end + 1).map((message, index) => ({
    ...message,
    providerOptions: fingerprintMetadata(message.providerOptions),
    content:
      typeof message.content === "string"
        ? message.content
        : message.content
            .slice(
              0,
              index === end && partEnd !== undefined ? partEnd + 1 : undefined,
            )
            .map((part) => {
              const target = copyPartWithoutCache(part);
              target.providerOptions = fingerprintMetadata(
                target.providerOptions,
              );
              if (target.type === "tool-result") {
                const output = target.output;
                if ("providerOptions" in output)
                  output.providerOptions = fingerprintMetadata(
                    output.providerOptions,
                  );
                if (output.type === "content") {
                  output.value = output.value.map((item) => ({
                    ...item,
                    providerOptions: fingerprintMetadata(item.providerOptions),
                  }));
                }
              }
              return target;
            }),
  }));
  return {
    version: 1,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(canonicalize(prefix)))
      .digest("hex"),
  };
}

/** Compatibility entry for callers inspecting prepared prompts. Policy lives in Rust. */
export async function applyPromptCachePolicy(messages: readonly LlmGatewayMessage[], options: PromptCachePolicyOptions): Promise<PromptCachePolicyResult> {
  const { prepareProvider } = await import("./native-client.js");
  const { asSchema } = await import("./tool-schema.js");
  const tools = await Promise.all(Object.entries(options.tools ?? {}).map(async ([name, tool]) => ({ ...tool, name,
    inputSchema: await asSchema(tool.inputSchema).jsonSchema })));
  const previousAnchorMatches = !options.previousHistoryAnchor || inspectHistoryCacheAnchor(messages, options.previousHistoryAnchor).historyAnchorStatus === "matched";
  const prepared = await prepareProvider({ apiFormat: options.selection.apiFormat, model: options.selection.modelId,
    prompt: [...messages], tools, cachePolicy: { adapter: options.selection.provider.npm, enabled: options.cacheControl,
      mode: resolvePromptCaching(options.selection.config.options?.promptCaching), previousAnchorMatches,
      chatBreakpoints: options.selection.config.options?.chatCacheBreakpoints,
      runtimeReminderIndices: options.runtimeReminderIndices } });
  // Native metadata is copied onto original host values so URL/byte references keep their identity.
  const restore = (original: unknown, native: unknown): unknown => {
    if (Array.isArray(original) && Array.isArray(native)) return original.map((item, i) => restore(item, native[i]));
    if (!original || typeof original !== "object" || !native || typeof native !== "object") return original;
    const source = original as Record<string, unknown>, result = { ...source };
    const target = native as Record<string, unknown>;
    if ("providerOptions" in target || "providerOptions" in source) result.providerOptions = target.providerOptions;
    for (const key of ["content", "output", "value"]) if (key in source) result[key] = restore(source[key], target[key]);
    return result;
  };
  return { messages: restore(messages, prepared.prompt) as LlmGatewayMessage[],
    ...(options.tools ? { tools: Object.fromEntries(Object.entries(options.tools).map(([name, tool], index) =>
      [name, restore(tool, prepared.tools?.[index])])) as ToolSet } : {}) };
}

/** Run after media hydration/compilation, in the same representation the policy sees. */
export function inspectHistoryCacheAnchor(
  messages: readonly LlmGatewayMessage[],
  previous?: HistoryCacheAnchor,
) {
  const reminders = messages.flatMap((message, index) =>
    isRuntimeReminder(message) ? [index] : [],
  );
  const before = reminders.at(-2);
  const historyAnchorStatus = !previous
    ? ("cold" as const)
    : before === undefined
      ? ("evicted" as const)
      : createHistoryCacheAnchor(messages, before).fingerprint ===
          previous.fingerprint
        ? ("matched" as const)
        : ("changed" as const);
  return {
    historyAnchor: createHistoryCacheAnchor(messages),
    historyAnchorStatus,
  };
}
