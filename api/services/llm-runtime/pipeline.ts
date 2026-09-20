import { applyUsageMiddleware } from "./middleware/usage.js";
import {
  applyPromptCachePolicy,
  inspectHistoryCacheAnchor,
} from "./cache-policy.js";
import {
  applyCacheDiagnosticsMiddleware,
  cacheDiagnosticsEnabled,
} from "./cache-diagnostics.js";
import { resolveMediaMessages } from "../agent-runtime/media-capabilities.js";
import { generateText, Output, streamText } from "ai";
import type {
  GenerateTextResult,
  ToolSet,
  ToolChoice,
  ToolCallRepairFunction,
} from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ModelMessage, SystemModelMessage } from "@ai-sdk/provider-utils";
import type { ZodType } from "zod";
import type { LlmGatewayRequest, ResolvedModelSelection } from "./types.js";
import { getOrCreateClient } from "./providers/provider-cache.js";
import { selectLanguageModel } from "./providers/provider-registry.js";
import { getStrategy } from "./providers/provider-strategy.js";
import { applyReasoningMiddleware } from "./middleware/reasoning.js";
import { applyJsonSchemaCompatMiddleware } from "./middleware/json-schema-compat.js";
import { applyResponsesReasoningMiddleware } from "./middleware/responses-reasoning.js";
import { buildHookCallbacks } from "./middleware/hook-callbacks.js";
import {
  toModelPrompt,
  ensureJsonObjectResponseFormatInstruction,
} from "./prompt.js";
import {
  buildThinkingDisabledOptions,
  buildThinkingStreamOptions,
  type ThinkingStreamOptions,
} from "./thinking-mode-strategy.js";
import { buildProtocolProviderOptions } from "./protocol-options.js";
import { mergeProviderOptions } from "./custom-api-compat.js";

const THINKING_DISABLED_PURPOSES = new Set([
  "session-title",
  "context-signal",
  "validate",
]);

function resolveThinkingOptions(
  request: LlmGatewayRequest,
  selection: ResolvedModelSelection,
): ThinkingStreamOptions {
  if (THINKING_DISABLED_PURPOSES.has(request.purpose)) {
    // Explicitly disable reasoning instead of merely omitting the thinking
    // options: otherwise a reasoning model burns the small output budget on
    // hidden tokens and the utility call returns empty text.
    return buildThinkingDisabledOptions(selection, request.temperature);
  }
  return buildThinkingStreamOptions(selection, request);
}

export type GatewayStreamResult = ReturnType<typeof streamText>;

export type ExecutionMode =
  | {
      kind: "stream";
      tools?: ToolSet;
      toolChoice?: ToolChoice<ToolSet>;
      activeTools?: string[];
      repairToolCall?: ToolCallRepairFunction<ToolSet>;
      maxRetries?: number;
    }
  | { kind: "text" }
  | { kind: "object"; schema: ZodType<unknown> };

const OFFICIAL_API_BASE_URLS = new Set([
  "https://api.anthropic.com/v1",
  "https://api.openai.com/v1",
]);

export function hasConfiguredApiKey(
  config: {
    apiKey?: string;
    baseUrl?: string;
    options?: Record<string, unknown>;
  },
  envNames: string[] = [],
): boolean {
  if (config.apiKey?.trim()) return true;
  const optionApiKey = config.options?.apiKey;
  if (typeof optionApiKey === "string" && optionApiKey.trim().length > 0)
    return true;
  if (envNames.some((name) => Boolean(process.env[name]?.trim()))) return true;
  const baseUrl = config.baseUrl?.replace(/\/$/, "");
  if (baseUrl && !OFFICIAL_API_BASE_URLS.has(baseUrl)) return true;
  return false;
}

export function missingApiKeyMessage(
  providerId: string,
  envNames: string[],
): string {
  const envHint = envNames.length > 0 ? ` or set ${envNames.join(" or ")}` : "";
  return `Missing API key for provider '${providerId}'. Configure one in Synax settings${envHint}.`;
}

function assertApiKey(selection: ResolvedModelSelection): void {
  if (!hasConfiguredApiKey(selection.config, selection.provider.env)) {
    throw new Error(
      missingApiKeyMessage(selection.providerId, selection.provider.env),
    );
  }
}

export function executePipeline(
  request: LlmGatewayRequest,
  selection: ResolvedModelSelection,
  mode: Extract<ExecutionMode, { kind: "stream" }>,
  abortSignal?: AbortSignal,
): Promise<GatewayStreamResult>;
export function executePipeline(
  request: LlmGatewayRequest,
  selection: ResolvedModelSelection,
  mode: ExecutionMode,
  abortSignal?: AbortSignal,
): Promise<unknown>;
export async function executePipeline(
  request: LlmGatewayRequest,
  selection: ResolvedModelSelection,
  mode: ExecutionMode,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  request = {
    ...request,
    messages: await resolveMediaMessages(
      request.messages,
      selection,
      request.projectId,
    ),
  };
  // Apply once to the complete request, including tools; all dispatch paths share the same budget.
  const cached = applyPromptCachePolicy(
    mode.kind === "object"
      ? ensureJsonObjectResponseFormatInstruction(request.messages)
      : request.messages,
    {
      selection,
      cacheControl: request.cacheControl,
      previousHistoryAnchor: request.previousHistoryAnchor,
      tools: mode.kind === "stream" ? mode.tools : request.tools,
    },
  );
  request = { ...request, messages: cached.messages, tools: cached.tools };
  if (mode.kind === "stream") mode = { ...mode, tools: cached.tools };
  assertApiKey(selection);

  const client = await getOrCreateClient(selection);
  const strategy = getStrategy(selection.provider.npm);
  const modelOptions = strategy.modelOptions(mode);
  let model = selectLanguageModel(
    client,
    selection.modelId,
    modelOptions,
    selection.apiFormat,
  ) as LanguageModelV4;

  // DeepSeek gateway models may use the native OpenAI Responses provider,
  // including when a custom OpenAI-compatible connection is resolved to the
  // Responses implementation. Normalize unsupported JSON Schema keywords
  // before @ai-sdk/openai sees the request, otherwise it logs a compatibility
  // warning for every call.
  if (
    selection.apiFormat === "openai-responses" ||
    selection.provider.npm === "@ai-sdk/openai"
  ) {
    model = applyJsonSchemaCompatMiddleware(model);
  }

  // DeepSeek-shaped Responses endpoints stream chain-of-thought as
  // `response.reasoning_text.delta`, an event @ai-sdk/openai does not model: it
  // opens and closes reasoning parts with no text, so thinking never reaches the
  // agent loop. Recover it from the raw SSE payload the adapter forwards.
  if (selection.apiFormat === "openai-responses") {
    model = applyResponsesReasoningMiddleware(model);
  }

  if (strategy.needsReasoningMiddleware(selection.modelDef)) {
    model = applyReasoningMiddleware(model);
  }

  model = applyUsageMiddleware(model, {
    source: "sdk",
    protocol: selection.apiFormat,
    adapter: selection.provider.npm,
    providerId: selection.providerId,
    sessionId: request.hookContext?.sessionId,
  });
  if (cacheDiagnosticsEnabled())
    model = applyCacheDiagnosticsMiddleware(model, {
      provider: selection.providerId,
      model: selection.modelId,
      protocol: selection.apiFormat,
      source: request.cacheDiagnosticsContext?.source ?? "auxiliary",
      ...request.cacheDiagnosticsContext,
    });
  // Policy has already handled every marker; the legacy system-only flag must not run again.
  const enableCache = undefined;
  const callbacks = buildHookCallbacks(request);
  const thinkingStream = resolveThinkingOptions(request, selection);
  const providerOptions = mergeProviderOptions(
    selection.config.options?.providerOptions as
      | import("@ai-sdk/provider-utils").ProviderOptions
      | undefined,
    request.providerOptions,
    thinkingStream.providerOptions,
    buildProtocolProviderOptions(selection, request),
    ...(selection.apiFormat === "openai-responses"
      ? [{ openai: { passThroughUnsupportedFiles: true } }]
      : []),
  );

  const temperature =
    selection.apiFormat === "openai-responses" &&
    providerOptions?.openai?.reasoningEffort !== "none" &&
    (providerOptions?.openai?.forceReasoning ?? selection.modelDef.reasoning)
      ? undefined
      : thinkingStream.temperature;
  const callOptions = { ...thinkingStream, providerOptions, temperature };

  // Native snapshots persist exactly the hydrated/compiled representation verified by policy.
  const preparedAnchor = inspectHistoryCacheAnchor(
    request.messages,
    request.previousHistoryAnchor,
  );
  await request.onRequestPrepared?.({
    messages: request.messages,
    ...preparedAnchor,
  });
  switch (mode.kind) {
    case "stream":
      return dispatchStream(
        model,
        request,
        mode,
        callbacks,
        enableCache,
        callOptions,
        selection.apiFormat === "openai-responses",
        abortSignal,
      );
    case "text":
      return dispatchText(
        model,
        request,
        callbacks,
        enableCache,
        callOptions,
        abortSignal,
      );
    case "object":
      return dispatchObject(
        model,
        request,
        mode.schema,
        callbacks,
        callOptions,
        abortSignal,
      );
  }
}

function dispatchStream(
  model: LanguageModelV4,
  request: LlmGatewayRequest,
  mode: Extract<ExecutionMode, { kind: "stream" }>,
  callbacks: ReturnType<typeof buildHookCallbacks>,
  enableCache: boolean | undefined,
  thinkingStream: ThinkingStreamOptions,
  includeRawChunks: boolean,
  abortSignal?: AbortSignal,
): GatewayStreamResult {
  const { system, messages } = toModelPrompt(request.messages, enableCache);
  return streamText({
    model,
    system,
    messages,
    tools: mode.tools,
    toolChoice: mode.toolChoice,
    activeTools: mode.activeTools,
    experimental_repairToolCall: mode.repairToolCall,
    temperature: thinkingStream.temperature,
    providerOptions: thinkingStream.providerOptions,
    maxOutputTokens: request.maxTokens,
    stopSequences: request.stop,
    maxRetries: mode.maxRetries,
    includeRawChunks,
    abortSignal,
    ...callbacks,
  });
}

function dispatchText(
  model: LanguageModelV4,
  request: LlmGatewayRequest,
  callbacks: ReturnType<typeof buildHookCallbacks>,
  enableCache: boolean | undefined,
  thinkingStream: ThinkingStreamOptions,
  abortSignal?: AbortSignal,
) {
  const { system, messages } = toModelPrompt(request.messages, enableCache);
  return generateText({
    maxRetries: 0,
    model,
    system,
    messages,
    temperature: thinkingStream.temperature,
    providerOptions: thinkingStream.providerOptions,
    maxOutputTokens: request.maxTokens,
    stopSequences: request.stop,
    abortSignal,
    ...callbacks,
  });
}

function dispatchObject(
  model: LanguageModelV4,
  request: LlmGatewayRequest,
  schema: ZodType<unknown>,
  callbacks: ReturnType<typeof buildHookCallbacks>,
  thinkingStream: ThinkingStreamOptions,
  abortSignal?: AbortSignal,
) {
  const { system, messages } = toModelPrompt(
    ensureJsonObjectResponseFormatInstruction(request.messages),
  );
  return generateText({
    maxRetries: 0,
    model,
    output: Output.object({ schema }),
    system,
    messages,
    temperature: thinkingStream.temperature,
    providerOptions: thinkingStream.providerOptions,
    maxOutputTokens: request.maxTokens,
    abortSignal,
    ...callbacks,
  });
}
