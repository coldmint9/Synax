import { createHash } from "node:crypto";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
import type { LlmGatewayMessage, ResolvedModelSelection } from "./types.js";

type ProviderOptions = ModelMessage["providerOptions"];
type CacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };
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

function cacheControl(options: ProviderOptions): CacheControl | undefined {
  const value =
    options?.anthropic?.cacheControl ?? options?.anthropic?.cache_control;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.type !== "ephemeral"
  )
    return undefined;
  if (value.ttl !== undefined && value.ttl !== "5m" && value.ttl !== "1h")
    return undefined;
  return { type: "ephemeral", ...(value.ttl ? { ttl: value.ttl } : {}) };
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

function mark(
  target: MetadataCarrier,
  value: CacheControl = { type: "ephemeral" },
): void {
  target.providerOptions = {
    ...target.providerOptions,
    anthropic: { ...target.providerOptions?.anthropic, cacheControl: value },
  };
}

function isRuntimeReminder(message: LlmGatewayMessage): boolean {
  if (message.role !== "user") return false;
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

/**
 * Pure request-local policy. Feed BOTH returned messages and tools to the SDK, then
 * call toModelPrompt(messages) without its legacy cache flag. No provider IDs,
 * hostnames, global anchor state, or arbitrary prompt bodies are consulted.
 *
 * Replayed reminders identify the same preceding history boundary as the previous
 * request, even when a whole turn adds >20 content blocks. Compression naturally
 * removes absent boundaries; no stale marker is reattached by position across calls.
 */
export function applyPromptCachePolicy(
  messages: readonly LlmGatewayMessage[],
  options: PromptCachePolicyOptions,
): PromptCachePolicyResult {
  const mode = resolvePromptCaching(
    options.selection.config.options?.promptCaching,
  );
  const enabled =
    mode !== "off" &&
    options.cacheControl !== false &&
    options.selection.apiFormat === "anthropic" &&
    options.selection.provider.npm === "@ai-sdk/anthropic";
  const candidates: Array<{ target: MetadataCarrier; index: number }> = [];
  const existing: Array<{ target: MetadataCarrier; value: CacheControl }> = [];
  const systems: MetadataCarrier[] = [];
  const toolTargets: MetadataCarrier[] = [];

  const copied = messages.map((message, index): LlmGatewayMessage => {
    const result = {
      ...message,
      providerOptions: withoutCache(message.providerOptions),
    };
    if (message.role === "system") {
      if (message.content.length > 0) {
        systems.push(result);
        const value = cacheControl(message.providerOptions);
        if (value) existing.push({ target: result, value });
      }
      return result as LlmGatewayMessage;
    }
    if (typeof message.content === "string") {
      if (message.content.length > 0) {
        candidates.push({ target: result, index });
        const value = cacheControl(message.providerOptions);
        if (value) existing.push({ target: result, value });
      }
      return result as LlmGatewayMessage;
    }
    const parts = message.content.map((part, partIndex) => {
      const target = copyPartWithoutCache(part);
      let outputCache: CacheControl | undefined;
      if (part.type === "tool-result") {
        const output = part.output;
        if ("providerOptions" in output)
          outputCache = cacheControl(output.providerOptions);
        if (output.type === "content")
          outputCache ??= cacheControl(
            output.value.find((item) => item.providerOptions != null)
              ?.providerOptions,
          );
      }
      const eligible = isEligiblePart(part, message.role);
      if (eligible) {
        candidates.push({ target, index });
        const value =
          cacheControl(
            "providerOptions" in part ? part.providerOptions : undefined,
          ) ??
          outputCache ??
          (partIndex === message.content.length - 1
            ? cacheControl(message.providerOptions)
            : undefined);
        if (value) existing.push({ target, value });
      }
      return target;
    });
    return { ...result, content: parts } as LlmGatewayMessage;
  });

  const tools =
    options.tools &&
    (Object.fromEntries(
      Object.entries(options.tools).map(([name, tool]) => {
        const target = {
          ...tool,
          providerOptions: withoutCache(tool.providerOptions),
        };
        toolTargets.push(target);
        const value = cacheControl(tool.providerOptions);
        if (value && tool.type !== "provider") existing.push({ target, value });
        return [name, target];
      }),
    ) as ToolSet | undefined);

  if (!enabled) return { messages: copied, ...(tools ? { tools } : {}) };

  const reminders = messages.flatMap((message, index) =>
    isRuntimeReminder(message) ||
    options.runtimeReminderIndices?.includes(index)
      ? [index]
      : [],
  );
  // Without a Native reminder, exclude the latest user input (and everything
  // after it) rather than guessing that a dynamic user tail is stable history.
  const latest =
    reminders.at(-1) ??
    messages.findLastIndex((message) => message.role === "user");
  const previous = reminders.at(-2);
  const before = (index: number | undefined) =>
    index === undefined
      ? undefined
      : candidates.findLast((candidate) => candidate.index < index)?.target;
  // TTL ordering follows actual wire hierarchy, not SDK validation traversal:
  // tools, then system, then messages. Honor explicit TTL only if compatible with
  // higher-priority choices. Never upgrade an implicit 5m marker to paid 1h.
  const wireOrder = new Map(
    [...toolTargets, ...systems, ...candidates.map((item) => item.target)].map(
      (target, index) => [target, index],
    ),
  );
  const existingValues = new Map(
    existing.map((item) => [item.target, item.value]),
  );
  const chosen = new Map<MetadataCarrier, CacheControl>();
  const add = (target: MetadataCarrier | undefined, value?: CacheControl) => {
    if (!target || chosen.has(target) || chosen.size >= 4) return;
    const control = value ??
      existingValues.get(target) ?? { type: "ephemeral" };
    const position = wireOrder.get(target)!;
    const long = control.ttl === "1h";
    for (const [other, otherControl] of chosen) {
      const otherPosition = wireOrder.get(other)!;
      if (
        (long && otherPosition < position && otherControl.ttl !== "1h") ||
        (!long && otherPosition > position && otherControl.ttl === "1h")
      )
        return;
    }
    chosen.set(target, control);
    mark(target, control);
  };
  const oldTarget = before(previous);
  const oldAnchorMatches =
    !options.previousHistoryAnchor ||
    (previous !== undefined &&
      options.previousHistoryAnchor.version === 1 &&
      options.previousHistoryAnchor.fingerprint ===
        createHistoryCacheAnchor(messages, previous).fingerprint);
  add(systems.at(-1));
  if (oldAnchorMatches) add(oldTarget);
  add(before(latest));
  for (const item of existing) {
    if (!oldAnchorMatches && item.target === oldTarget) continue;
    // Do not retain caller-supplied markers on the latest runtime reminder/tail.
    const candidate = candidates.find(
      (candidate) => candidate.target === item.target,
    );
    if (candidate && (latest < 0 || candidate.index >= latest)) continue;
    add(item.target, item.value);
  }
  return { messages: copied, ...(tools ? { tools } : {}) };
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
