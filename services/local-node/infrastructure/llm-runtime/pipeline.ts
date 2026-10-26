import type { ZodType } from "zod";
import { z } from "zod";
import type { ToolSet, ToolChoice, ProviderOptions, ProviderRequest } from "./contracts.js";
import type { LlmGatewayRequest, ResolvedModelSelection } from "./types.js";
import { inspectHistoryCacheAnchor } from "./cache-policy.js";
import { resolveMediaMessages } from "../../modules/agent-runtime/media-capabilities.js";
import { ensureJsonObjectResponseFormatInstruction } from "./prompt.js";
import { mergeProviderOptions } from "./connection-options.js";
import { outputProtocolOptions } from "./model-output-limits.js";
import { streamProvider, prepareProvider } from "./native-client.js";
import { cacheDiagnosticsEnabled, fingerprintRequest } from "./cache-diagnostics.js";
import { asSchema } from "./tool-schema.js";
import { gatewayResult, collectGatewayResult, type GatewayStreamResult } from "./gateway-result.js";
export type { GatewayStreamResult } from "./gateway-result.js";
export type ExecutionMode =
  | { kind: "stream"; tools?: ToolSet; toolChoice?: ToolChoice; activeTools?: string[]; maxRetries?: number }
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
  if (selection.apiFormat === "jev") {
    throw new Error(
      "Jev / TypeSafe System One connections are only available for Computer Use, not ordinary chat completion.",
    );
  }
  request = {
    ...request,
    messages: await resolveMediaMessages(
      request.messages,
      selection,
      request.projectId,
    ),
  };
  request = { ...request,
    ...(mode.kind === "stream" ? { tools: mode.tools ?? request.tools, activeTools: mode.activeTools ?? request.activeTools, toolChoice: mode.toolChoice ?? request.toolChoice } : {}),
    messages: mode.kind === "object" ? ensureJsonObjectResponseFormatInstruction(request.messages) : request.messages,
  };
  assertApiKey(selection);

  const providerOptions = mergeProviderOptions(
    selection.config.options?.providerOptions as ProviderOptions | undefined,
    request.providerOptions,
  );
  const tools = [];
  for (const [name, tool] of Object.entries(request.tools ?? {})) {
    if (request.activeTools && !request.activeTools.includes(name)) continue;
    tools.push(tool.type === "provider-defined" || tool.type === "provider"
      ? { type: "provider", name, id: tool.id, args: tool.args }
      : { type: "function", name, description: tool.description, inputSchema: await asSchema(tool.inputSchema).jsonSchema, providerOptions: tool.providerOptions });
  }
  const choice = request.toolChoice;
  const headers = selection.config.options?.headers as Record<string, string> | undefined;
  const wire: ProviderRequest = {
    providerId: selection.providerId, apiFormat: selection.apiFormat, adapter: selection.provider.npm,
    baseUrl: selection.config.baseUrl ?? selection.provider.api,
    apiKey: selection.config.apiKey ?? selection.config.options?.apiKey as string | undefined
      ?? selection.provider.env.map(name => process.env[name]?.trim()).find(Boolean),
    headers, model: selection.modelId,
    prompt: request.messages,
    cachePolicy: { adapter: selection.provider.npm, enabled: request.cacheControl, mode: selection.config.options?.promptCaching,
      chatBreakpoints: selection.config.options?.chatCacheBreakpoints, projectId: request.projectId, sessionId: request.hookContext?.sessionId,
      previousAnchorMatches: !request.previousHistoryAnchor || inspectHistoryCacheAnchor(request.messages, request.previousHistoryAnchor).historyAnchorStatus === "matched" },
    tools, toolChoice: typeof choice === "string" ? { type: choice } : choice,
    maxOutputTokens: request.maxTokens ?? selection.config.maxOutputTokens, stopSequences: request.stop,
    ...outputProtocolOptions(selection, request.reasoningEffort),
    temperature: request.temperature, purpose: request.purpose,
    reasoningEffort: request.reasoningEffort, reasoningCapable: selection.modelDef.reasoning,
    supportedReasoningEfforts: selection.modelDef.supportedReasoningEfforts,
    responseOptions: request.responseOptions as Record<string, unknown> | undefined,
    providerOptions, maxRetries: mode.kind === "stream" ? mode.maxRetries ?? request.maxRetries : request.maxRetries,
    ...(mode.kind === "object" ? { responseFormat: { type: "json" as const, schema: z.toJSONSchema(mode.schema, { target: "draft-7", unrepresentable: "any" }) } } : {}),
  };
  await request.onRequestPrepared?.({ messages: request.messages, ...inspectHistoryCacheAnchor(request.messages, request.previousHistoryAnchor) });
  let diagnostics: Record<string, unknown> | undefined;
  if (cacheDiagnosticsEnabled()) {
    const prepared = await prepareProvider(wire, abortSignal);
    diagnostics = { ...request.cacheDiagnosticsContext, provider: selection.providerId, model: selection.modelId,
      protocol: selection.apiFormat, boundary: "native-bridge", request: fingerprintRequest(prepared.prompt as Array<{ role: string; content: unknown }>, prepared.tools) };
  }
  const stream = gatewayResult(streamProvider(wire, abortSignal), request, selection.modelId, selection.providerId, diagnostics);
  if (mode.kind === "stream") return stream;
  const result = await collectGatewayResult(stream);
  if (mode.kind === "object") result.output = mode.schema.parse(result.output);
  return result;
}
