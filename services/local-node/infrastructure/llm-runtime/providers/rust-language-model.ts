import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";

type RustProviderConfig = {
  providerId: string;
  adapter?: string;
  apiFormat: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
};

type RustEvent = {
  type: string;
  delta?: string;
  id?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  usage?: Record<string, number | undefined>;
  finishReason?: string;
  rawFinishReason?: string;
  rawValue?: unknown;
  error?: unknown;
};

export function createRustLanguageModel(
  config: RustProviderConfig,
  modelId: string,
): LanguageModelV4 {
  return new RustLanguageModel(config, modelId);
}

class RustLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls = {};

  constructor(
    private readonly config: RustProviderConfig,
    modelId: string,
  ) {
    this.provider = `rust/${config.providerId}`;
    this.modelId = modelId;
  }

  async doStream(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    const port = Number(process.env.SYNAX_RUNTIME_PROVIDER_PORT);
    const token = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
    if (!Number.isInteger(port) || port <= 0 || !token) {
      throw new Error("Rust provider bridge is not available.");
    }
    const body = {
      providerId: this.config.providerId,
      apiFormat: this.config.apiFormat,
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey ?? this.config.options?.apiKey,
      headers: { ...this.config.headers, ...(this.config.options?.headers as Record<string, string> | undefined), ...options.headers },
      model: this.modelId,
      prompt: options.prompt,
      tools: options.tools,
      toolChoice: options.toolChoice,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      seed: options.seed,
      stopSequences: options.stopSequences,
      providerOptions: options.providerOptions,
      responseFormat: options.responseFormat,
    };
    const response = await fetch(`http://127.0.0.1:${port}/provider/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: stringifyRustRequest(body),
      signal: options.abortSignal,
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(
        `Rust provider bridge returned HTTP ${response.status}: ${message || response.statusText}`,
      );
    }
    if (!response.body) throw new Error("Rust provider bridge returned no stream.");
    const { apiKey: _apiKey, headers: _headers, ...publicRequest } = body;
    return {
      stream: toLanguageModelStream(response.body, options),
      request: { body: publicRequest },
    };
  }

  async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const result = await this.doStream(options);
    const reader = result.stream.getReader();
    const content: Array<Record<string, unknown>> = [];
    let text = "";
    let reasoning = "";
    let finishReason: LanguageModelV4GenerateResult["finishReason"] = {
      unified: "stop",
      raw: undefined,
    };
    let usage = emptyUsage();
    let rawBody: unknown;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value as Record<string, unknown>;
      if (part.type === "text-delta") text += String(part.delta ?? "");
      else if (part.type === "reasoning-delta") reasoning += String(part.delta ?? "");
      else if (part.type === "tool-call") content.push(part);
      else if (part.type === "raw") {
        const raw = part.rawValue as Record<string, unknown> | undefined;
        if (raw?.usage !== undefined) rawBody = raw;
      }
      else if (part.type === "error") throw part.error;
      else if (part.type === "finish") {
        finishReason = part.finishReason as typeof finishReason;
        usage = part.usage as typeof usage;
      }
    }
    if (reasoning) content.unshift({ type: "reasoning", text: reasoning });
    if (text) content.push({ type: "text", text });
    return {
      content: content as LanguageModelV4GenerateResult["content"],
      finishReason,
      usage,
      warnings: [],
      request: result.request,
      ...(rawBody ? { response: { body: rawBody } } : {}),
    };
  }
}

/** Binary media is inline base64 on the Rust boundary, never JSON byte maps. */
export function stringifyRustRequest(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) return Buffer.from(item).toString("base64");
    // Buffer.toJSON runs before the replacer.
    if (item && typeof item === "object" && "type" in item && item.type === "Buffer" && "data" in item && Array.isArray(item.data))
      return Buffer.from(item.data).toString("base64");
    return item;
  });
}

function toLanguageModelStream(
  body: ReadableStream<Uint8Array>,
  options: LanguageModelV4CallOptions,
): ReadableStream<LanguageModelV4StreamPart> {
  const reader = body.getReader();
  let cancelled = false;
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      void pumpRustEvents(reader, options, controller, () => cancelled)
        .catch((error) => { if (!cancelled) controller.error(error); })
        .finally(() => reader.releaseLock());
    },
    async cancel(reason) { cancelled = true; await reader.cancel(reason); },
  });
}

async function pumpRustEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: LanguageModelV4CallOptions,
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
  cancelled: () => boolean,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  let textStarted = false;
  let reasoningIds = new Set<string>();
  let textEnded = false;
  let lastUsage: RustEvent["usage"];
  for (;;) {
    if (options.abortSignal?.aborted) {
      await reader.cancel(options.abortSignal.reason);
      throw options.abortSignal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const next = await reader.read();
    if (cancelled()) return;
    pending += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed) as RustEvent;
      emitRustEvent(event, controller, {
        textStarted: () => textStarted,
        setTextStarted: () => { textStarted = true; },
        reasoningIds,
        getUsage: () => lastUsage,
        setUsage: (usage) => { lastUsage = usage; },
        textEnded: () => textEnded,
        setTextEnded: () => { textEnded = true; },
      });
    }
    if (next.done) break;
  }
  if (pending.trim()) emitRustEvent(JSON.parse(pending) as RustEvent, controller, {
    textStarted: () => textStarted,
    setTextStarted: () => { textStarted = true; },
    reasoningIds,
    getUsage: () => lastUsage,
    setUsage: (usage) => { lastUsage = usage; },
    textEnded: () => textEnded,
    setTextEnded: () => { textEnded = true; },
  });
  if (textStarted && !textEnded) controller.enqueue({ type: "text-end", id: "rust-text" });
  controller.close();
}

function emitRustEvent(
  event: RustEvent,
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
  state: {
    textStarted: () => boolean;
    setTextStarted: () => void;
    reasoningIds: Set<string>;
    getUsage: () => RustEvent["usage"];
    setUsage: (usage: RustEvent["usage"]) => void;
    textEnded: () => boolean;
    setTextEnded: () => void;
  },
): void {
  switch (event.type) {
    case "stream-start":
      controller.enqueue({ type: "stream-start", warnings: [] });
      break;
    case "text-delta":
      if (!state.textStarted()) {
        state.setTextStarted();
        controller.enqueue({ type: "text-start", id: "rust-text" });
      }
      controller.enqueue({ type: "text-delta", id: "rust-text", delta: event.delta ?? "" });
      break;
    case "reasoning-delta": {
      const id = event.id ?? "rust-reasoning";
      if (!state.reasoningIds.has(id)) {
        state.reasoningIds.add(id);
        controller.enqueue({ type: "reasoning-start", id });
      }
      controller.enqueue({ type: "reasoning-delta", id, delta: event.delta ?? "" });
      break;
    }
    case "tool-call":
      controller.enqueue({
        type: "tool-call",
        toolCallId: event.toolCallId ?? crypto.randomUUID(),
        toolName: event.toolName ?? "",
        input: JSON.stringify(event.input ?? {}),
      });
      break;
    case "usage":
      state.setUsage(event.usage);
      break;
    case "raw":
      if (event.rawValue !== undefined) controller.enqueue({ type: "raw", rawValue: event.rawValue });
      break;
    case "finish":
      for (const id of state.reasoningIds) controller.enqueue({ type: "reasoning-end", id });
      state.reasoningIds.clear();
      if (state.textStarted() && !state.textEnded()) {
        state.setTextEnded();
        controller.enqueue({ type: "text-end", id: "rust-text" });
      }
      controller.enqueue({
        type: "finish",
        usage: normalizeUsage(state.getUsage()),
        finishReason: toFinishReason(event.finishReason, event.rawFinishReason),
      });
      break;
    case "error":
      controller.enqueue({ type: "error", error: event.error ?? "Rust provider error" });
      break;
    default:
      break;
  }
}

function emptyUsage(): LanguageModelV4GenerateResult["usage"] {
  return normalizeUsage();
}

function normalizeUsage(usage?: RustEvent["usage"]): LanguageModelV4GenerateResult["usage"] {
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const input = number(usage?.inputTokens);
  const output = number(usage?.outputTokens);
  const cacheRead = number(usage?.cachedInputTokens);
  const cacheWrite = number(usage?.cacheWriteTokens);
  const reasoning = number(usage?.reasoningTokens);
  return {
    inputTokens: {
      total: input,
      noCache: input === undefined ? undefined : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0)),
      cacheRead,
      cacheWrite,
    },
    outputTokens: { total: output, text: output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0)), reasoning },
  };
}

function toFinishReason(
  finishReason?: string,
  rawFinishReason?: string,
): { unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"; raw: string | undefined } {
  const unified = finishReason === "tool-calls" || finishReason === "length" || finishReason === "error" || finishReason === "content-filter"
    ? finishReason
    : finishReason === "stop" ? "stop" : "other";
  return { unified, raw: rawFinishReason ?? finishReason };
}

