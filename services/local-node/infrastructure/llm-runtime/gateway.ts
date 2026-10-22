import type { ZodType } from "zod";
import { getGlobalConfigForRuntime, getProjectConfigForRuntime } from "../runtime/config/config-store.js";
import { getRuntimeCatalog } from "./catalog.js";
import { resolveLlmSelection, resolveProviderApiFormat, resolveProviderModelRef, resolveRuntimeProvider } from "./resolver.js";
import type { LlmGatewayRequest, ResolvedModelSelection, ValidateLlmRequest } from "./types.js";
import { executePipeline, hasConfiguredApiKey, missingApiKeyMessage } from "./pipeline.js";
import type { GatewayStreamResult, GatewayTextResult } from "./gateway-result.js";
export interface GatewayObjectResult<T> { object: T; result: GatewayTextResult }
export async function resolveGatewaySelection(
  request: Pick<LlmGatewayRequest, "projectId" | "purpose" | "model">,
): Promise<ResolvedModelSelection> {
  const catalog = await getRuntimeCatalog();
  const globalConfig = getGlobalConfigForRuntime();
  return resolveLlmSelection({
    catalog,
    globalConfig,
    projectConfig: request.projectId
      ? getProjectConfigForRuntime(request.projectId)
      : null,
    purpose: request.purpose,
    modelOverride: request.model,
    // Latency-sensitive purposes route to the fast/small model tier.
    useSmallModel: request.purpose === "context-signal",
  });
}

export async function createGatewayStream(request: LlmGatewayRequest, signal?: AbortSignal): Promise<GatewayStreamResult> {
  return createGatewayStreamForSelection(request, await resolveGatewaySelection(request), signal);
}
export function createGatewayStreamForSelection(request: LlmGatewayRequest, selection: ResolvedModelSelection, signal?: AbortSignal): Promise<GatewayStreamResult> {
  return executePipeline(request, selection, { kind: "stream", tools: request.tools, toolChoice: request.toolChoice,
    activeTools: request.activeTools, maxRetries: request.maxRetries }, signal);
}
export async function generateGatewayTextResult(request: LlmGatewayRequest, signal?: AbortSignal): Promise<GatewayTextResult> {
  return executePipeline(request, await resolveGatewaySelection(request), { kind: "text" }, signal) as Promise<GatewayTextResult>;
}
export async function generateGatewayObjectResult<T>(request: LlmGatewayRequest, schema: ZodType<T>, signal?: AbortSignal): Promise<GatewayObjectResult<T>> {
  const result = await executePipeline(request, await resolveGatewaySelection(request), { kind: "object", schema }, signal) as GatewayTextResult;
  return { object: result.output as T, result };
}
export async function generateGatewayObject<T>(request: LlmGatewayRequest, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
  return (await generateGatewayObjectResult(request, schema, signal)).object;
}
export async function validateGatewayModel(
  input: ValidateLlmRequest,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const parsed = resolveValidationTarget(input);
  const catalog = await getRuntimeCatalog();
  const globalConfig = getGlobalConfigForRuntime();
  const provider = resolveRuntimeProvider(parsed.providerId, {
    catalog,
    globalConfig,
    projectConfig: null,
    purpose: "validate",
  });
  if (!provider) {
    return { ok: false, error: `Unknown provider: ${parsed.providerId}` };
  }
  if (!provider.supported) {
    return {
      ok: false,
      error: `Provider '${parsed.providerId}' is unsupported in Synax runtime`,
    };
  }

  try {
    const config = {
      providerId: parsed.providerId,
      apiFormat: input.apiFormat,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      options: input.options,
    };
    if (!hasConfiguredApiKey(config, provider.env)) {
      return {
        ok: false,
        error: missingApiKeyMessage(parsed.providerId, provider.env),
      };
    }
    const apiFormat =
      input.apiFormat ??
      resolveProviderApiFormat({
        providerId: parsed.providerId,
        connection: globalConfig.providerConnections[parsed.providerId],
        modelId: parsed.modelId,
      });
    config.apiFormat = apiFormat;
    await executePipeline({ purpose: "validate", messages: [{ role: "user", content: "ping" }], maxTokens: 1 }, {
      model: `${parsed.providerId}/${parsed.modelId}`, providerId: parsed.providerId, modelId: parsed.modelId,
      apiFormat, provider, modelDef: { id: parsed.modelId, label: parsed.modelId }, config,
    }, { kind: "text" });
    return {
      ok: true,
      message: `${parsed.providerId}/${parsed.modelId} validated`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

function resolveValidationTarget(input: ValidateLlmRequest): {
  providerId: string;
  modelId: string;
} {
  if (input.providerId) {
    return { providerId: input.providerId, modelId: input.model };
  }
  const parsed = resolveProviderModelRef(input.model);
  if (!parsed) {
    throw new Error(
      "Validation requires either providerId + model, or model in provider/model format",
    );
  }
  return parsed;
}
