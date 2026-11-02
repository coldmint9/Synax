import {
  getGlobalConfigForRuntime,
} from "../runtime/config/config-store.js";
import type {
  AiApiModelsDiscoverRequest,
  AiApiModelsDiscoverResponse,
  ApiFormat,
} from "../runtime/config/config-types.js";
import { getRuntimeCatalog } from "./catalog.js";

/**
 * Model discovery for user-supplied OpenAI / Responses / Anthropic / Jev
 * endpoints. Shared by the settings route and by the provider import flow, so
 * both agree on the `/v1` fallback and the returned metadata.
 */

export function normalizeJevBaseUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function normalizeAiApiBaseUrl(baseUrl: string, format: ApiFormat): string {
  return format === "jev"
    ? normalizeJevBaseUrl(baseUrl)
    : baseUrl.replace(/\/+$/, "");
}

export async function validationError(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => "");
  if (resp.status === 401 || resp.status === 403)
    return `认证失败 (${resp.status})`;
  if (resp.status === 404) return `接口路径不存在 (${resp.status})`;
  if (resp.status === 400)
    return `请求被拒绝 (${resp.status}): ${text.slice(0, 240)}`;
  return `请求失败 (${resp.status}): ${text.slice(0, 240) || resp.statusText}`;
}

/** Resolve the key for a request: explicit input first, then the stored connection. */
export function resolveAiApiKey(
  providerId: string | undefined,
  apiKey: string | undefined,
): string {
  const direct = apiKey?.trim();
  if (direct) return direct;
  if (!providerId) return "";

  const global = getGlobalConfigForRuntime();
  const provider = global.providers.find((item) => item.id === providerId);
  const connection = global.providerConnections[providerId];
  if (!provider || provider.kind !== "api" || !connection) return "";
  return connection.apiKey?.trim() ?? "";
}

export function extractModelIds(payload: unknown): string[] {
  const candidates: string[] = [];

  if (payload && typeof payload === "object") {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === "string") candidates.push(item);
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string"
        ) {
          candidates.push((item as { id: string }).id);
        }
      }
    }

    const models = (payload as { models?: unknown }).models;
    if (Array.isArray(models)) {
      for (const item of models) {
        if (typeof item === "string") candidates.push(item);
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string"
        ) {
          candidates.push((item as { id: string }).id);
        }
      }
    }
  }

  return Array.from(
    new Set(candidates.filter((item) => item.trim().length > 0)),
  );
}

function buildModelDiscoveryHeaders(
  format: ApiFormat,
  apiKey: string,
): Record<string, string> {
  if (format === "anthropic") {
    return {
      Accept: "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

export function modelDiscoverySource(format: ApiFormat): string {
  if (format === "anthropic") return "anthropic/models";
  if (format === "jev") return "typesafe/models";
  return "openai/models";
}

async function tryDiscoverModels(
  baseUrl: string,
  format: ApiFormat,
  apiKey: string,
  signal: AbortSignal,
): Promise<{
  ok: boolean;
  status: number;
  models: string[];
  error?: string;
  resolvedBaseUrl?: string;
}> {
  const endpoint = format === "jev"
    ? `${normalizeJevBaseUrl(baseUrl)}/v1/models`
    : `${baseUrl}/models`;
  const resp = await fetch(endpoint, {
    method: "GET",
    headers: buildModelDiscoveryHeaders(format, apiKey),
    signal,
  });
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      models: [],
      error: await validationError(resp),
    };
  }
  const payload = await resp.json().catch(() => ({}));
  const models = extractModelIds(payload);
  return {
    ok: true,
    status: resp.status,
    models,
    ...(models.length === 0 ? { error: "模型接口未返回可识别的模型 ID" } : {}),
  };
}

async function withCatalogMetadata(
  result: { ok: boolean; models: string[]; error?: string },
  providerId: string | undefined,
  source: string,
  resolvedBaseUrl?: string,
): Promise<AiApiModelsDiscoverResponse> {
  const catalog = await getRuntimeCatalog();
  const preferred = providerId
    ? catalog.providers.find((provider) => provider.id === providerId)
    : undefined;
  const modelMetadata: NonNullable<AiApiModelsDiscoverResponse["modelMetadata"]> = {};
  for (const modelId of result.models) {
    const model = preferred?.models.find((item) => item.id === modelId)
      ?? catalog.providers.flatMap((provider) => provider.models).find((item) => item.id === modelId);
    if (!model) continue;
    modelMetadata[modelId] = {
      contextLimit: model.contextLimit,
      inputLimit: model.inputLimit,
      outputLimit: model.maxTokens,
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
      reasoning: model.reasoning,
      toolCall: model.toolCall,
    };
  }
  return {
    ...result,
    source,
    ...(resolvedBaseUrl ? { resolvedBaseUrl } : {}),
    ...(Object.keys(modelMetadata).length ? { modelMetadata } : {}),
  };
}

/**
 * Discover models for an API endpoint.
 *
 * A base URL without `/v1` is retried once as `<baseUrl>/v1` when the first
 * attempt answers 404; the working URL is returned as `resolvedBaseUrl` so
 * callers can persist what actually answered.
 */
export async function discoverAiApiModels(
  input: AiApiModelsDiscoverRequest,
): Promise<AiApiModelsDiscoverResponse> {
  const baseUrl = normalizeAiApiBaseUrl(input.baseUrl, input.format);
  const apiKey = resolveAiApiKey(input.providerId, input.apiKey);
  if (!apiKey) {
    return {
      ok: false,
      models: [],
      source: modelDiscoverySource(input.format),
      error: "请先配置 API Key",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const result = await tryDiscoverModels(
      baseUrl,
      input.format,
      apiKey,
      controller.signal,
    );
    if (result.ok)
      return withCatalogMetadata(result, input.providerId, modelDiscoverySource(input.format));

    if (result.status === 404 && !baseUrl.endsWith("/v1")) {
      const altUrl = `${baseUrl}/v1`;
      const retry = await tryDiscoverModels(
        altUrl,
        input.format,
        apiKey,
        controller.signal,
      );
      if (retry.ok)
        return withCatalogMetadata(
          retry,
          input.providerId,
          modelDiscoverySource(input.format),
          altUrl,
        );
    }

    return { ...result, source: modelDiscoverySource(input.format) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      models: [],
      source: modelDiscoverySource(input.format),
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
