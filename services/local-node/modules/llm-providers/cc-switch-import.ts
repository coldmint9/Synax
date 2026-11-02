import { createHash } from "node:crypto";
import { discoverAiApiModels } from "../../infrastructure/llm-runtime/ai-api-models.js";
import type {
  AiApiModelsDiscoverRequest,
  AiApiModelsDiscoverResponse,
  ApiFormat,
  GlobalConfig,
  ProviderConnection,
  ProviderDef,
  ProviderModelDef,
  UpdateGlobalConfigRequest,
} from "../../infrastructure/runtime/config/config-types.js";
import { mapCcSwitchRecords } from "./cc-switch-mapping.js";
import type {
  CcSwitchConflictKind,
  CcSwitchConflictPolicy,
  CcSwitchImportAction,
  CcSwitchImportItem,
  CcSwitchProviderCandidate,
  CcSwitchProviderRecord,
} from "./cc-switch-contracts.js";

/**
 * Import orchestration for CC Switch providers.
 *
 * The pipeline is deliberately split so the decisions stay testable without a
 * network or a config file:
 *   preview  → what could be imported, and what it would collide with
 *   plan     → which candidates become create / update / skip
 *   resolve  → probe the endpoint and settle the models and base URL
 *   patch    → one UpdateGlobalConfigRequest with every change
 */

const CUSTOM_API_PREFIX = "custom-api:";
const IMPORT_ID_PREFIX = `${CUSTOM_API_PREFIX}ccsw-`;
const BUILTIN_PROVIDER_IDS = new Set(["openai", "anthropic"]);
const PROBE_CONCURRENCY = 3;

/** Media/subscription models cannot serve as a chat provider model. */
const NON_CHAT_MODEL = /(?:^|[-_/])(?:embedding|rerank|tts|whisper|moderation|dall-e|gpt-image|chatgpt-image|imagen|flux|ideogram|sdxl|sd3|sora|veo|kling|seedance|hailuo|pika|imagine)(?:[-_/]|$)/i;

export function ccSwitchProviderId(appType: string, sourceId: string): string {
  const digest = createHash("sha256")
    .update(`${appType}:${sourceId}`)
    .digest("hex")
    .slice(0, 8);
  return `${IMPORT_ID_PREFIX}${digest}`;
}

/** Endpoint comparison ignores trailing slashes and case. */
export function normalizeEndpoint(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().toLowerCase().replace(/\/+$/, "");
}

function endpointIndex(config: GlobalConfig): Map<string, string> {
  const index = new Map<string, string>();
  for (const provider of config.providers) {
    if (provider.kind !== "api") continue;
    // Built-in vendors are not the user's gateways: never treat them as a conflict target.
    if (BUILTIN_PROVIDER_IDS.has(provider.id)) continue;
    const endpoint = normalizeEndpoint(config.providerConnections[provider.id]?.baseUrl);
    if (!endpoint) continue;
    if (!index.has(endpoint)) index.set(endpoint, provider.id);
  }
  return index;
}

function uniqueProviderId(baseId: string, taken: Set<string>): string {
  if (!taken.has(baseId)) return baseId;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseId}-${Date.now()}`;
}

export function buildPreview(
  config: GlobalConfig,
  candidates: CcSwitchProviderCandidate[],
): CcSwitchImportItem[] {
  const providerIds = new Set(config.providers.map((provider) => provider.id));
  const endpoints = endpointIndex(config);

  return candidates.map((candidate) => {
    const expectedId = ccSwitchProviderId(candidate.appType, candidate.sourceId);
    const duplicate = providerIds.has(expectedId) ? expectedId : undefined;
    const sameEndpoint = endpoints.get(normalizeEndpoint(candidate.baseUrl));
    const conflict: CcSwitchConflictKind = duplicate
      ? "duplicate-id"
      : sameEndpoint
        ? "same-endpoint"
        : "none";
    const conflictProviderId = duplicate ?? sameEndpoint;
    const selectable = candidate.models.length > 0;

    return {
      key: candidate.key,
      appType: candidate.appType,
      label: candidate.label,
      baseUrl: candidate.baseUrl,
      apiFormat: candidate.apiFormat,
      apiKeyMasked: candidate.apiKeyMasked,
      declaredModels: candidate.models.map((model) => model.id),
      defaultModel: candidate.defaultModel,
      conflict,
      ...(conflictProviderId ? { conflictProviderId } : {}),
      selectable,
      ...(selectable ? {} : { reason: "没有可用模型" }),
      warnings: [...candidate.warnings],
    };
  });
}

export interface PlannedImport {
  candidate: CcSwitchProviderCandidate;
  /** Provider id written by this import. */
  providerId: string;
  /** Existing provider updated in place, when the plan reuses one. */
  targetProviderId?: string;
  action: "created" | "updated";
}

export interface ImportPlan {
  entries: PlannedImport[];
  skipped: CcSwitchImportAction[];
}

export function planImport(
  config: GlobalConfig,
  candidates: CcSwitchProviderCandidate[],
  policy: CcSwitchConflictPolicy,
): ImportPlan {
  const providerIds = new Set(config.providers.map((provider) => provider.id));
  const endpoints = endpointIndex(config);
  const entries: PlannedImport[] = [];
  const skipped: CcSwitchImportAction[] = [];

  for (const candidate of candidates) {
    const expectedId = ccSwitchProviderId(candidate.appType, candidate.sourceId);
    const sameEndpoint = endpoints.get(normalizeEndpoint(candidate.baseUrl));

    if (providerIds.has(expectedId)) {
      if (policy === "skip") {
        skipped.push({ providerId: expectedId, label: candidate.label, action: "skipped", reason: "已导入过" });
        continue;
      }
      if (policy === "replace") {
        entries.push({ candidate, providerId: expectedId, targetProviderId: expectedId, action: "updated" });
        continue;
      }
      const copied = uniqueProviderId(expectedId, providerIds);
      providerIds.add(copied);
      entries.push({ candidate, providerId: copied, action: "created" });
      continue;
    }

    if (sameEndpoint) {
      if (policy === "skip") {
        skipped.push({
          providerId: sameEndpoint,
          label: candidate.label,
          action: "skipped",
          reason: "已存在相同端点的供应商",
        });
        continue;
      }
      if (policy === "replace") {
        entries.push({ candidate, providerId: sameEndpoint, targetProviderId: sameEndpoint, action: "updated" });
        continue;
      }
    }

    providerIds.add(expectedId);
    entries.push({ candidate, providerId: expectedId, action: "created" });
  }

  return { entries, skipped };
}

export interface ResolvedImport extends PlannedImport {
  baseUrl: string;
  apiFormat: ApiFormat;
  models: ProviderModelDef[];
  defaultModel: string;
  /** Discovery succeeded and the models came from the endpoint. */
  probed: boolean;
}

type DiscoverFn = (input: AiApiModelsDiscoverRequest) => Promise<AiApiModelsDiscoverResponse>;

function declaredModels(candidate: CcSwitchProviderCandidate): ProviderModelDef[] {
  return candidate.models.map((model) => ({
    id: model.id,
    label: model.id,
    isDefault: model.id === candidate.defaultModel,
    capabilities: ["chat"],
    ...(model.contextLimit ? { contextLimit: model.contextLimit } : {}),
    ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}),
  }));
}

function probedModels(
  candidate: CcSwitchProviderCandidate,
  discovery: AiApiModelsDiscoverResponse,
): ProviderModelDef[] {
  const declared = new Map(candidate.models.map((model) => [model.id, model]));
  const ids = discovery.models
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && !NON_CHAT_MODEL.test(id));
  if (ids.length === 0) return [];

  const unique = [...new Set(ids)];
  const defaultModel = unique.includes(candidate.defaultModel)
    ? candidate.defaultModel
    : unique[0]!;

  return unique.map((id) => {
    const meta = discovery.modelMetadata?.[id];
    const declaredModel = declared.get(id);
    const contextLimit = meta?.contextLimit ?? declaredModel?.contextLimit;
    const inputModalities = (meta?.inputModalities ?? declaredModel?.inputModalities ?? [])
      .filter((value): value is "text" | "image" | "audio" | "video" | "file" =>
        ["text", "image", "audio", "video", "file"].includes(value),
      );
    return {
      id,
      label: id,
      isDefault: id === defaultModel,
      capabilities: ["chat"],
      ...(contextLimit ? { contextLimit } : {}),
      ...(inputModalities.length ? { inputModalities } : {}),
    };
  });
}

async function resolveEntry(
  entry: PlannedImport,
  discover: DiscoverFn,
): Promise<{ resolved: ResolvedImport; warning?: string }> {
  const fallbackModels = declaredModels(entry.candidate);
  let baseUrl = entry.candidate.baseUrl;
  let models = fallbackModels;
  let probed = false;
  let warning: string | undefined;

  try {
    const discovery = await discover({
      format: entry.candidate.apiFormat,
      baseUrl: entry.candidate.baseUrl,
      apiKey: entry.candidate.apiKey,
    });
    if (discovery.ok) {
      const discovered = probedModels(entry.candidate, discovery);
      if (discovered.length > 0) {
        models = discovered;
        probed = true;
        if (discovery.resolvedBaseUrl) baseUrl = discovery.resolvedBaseUrl;
      } else {
        warning = `${entry.candidate.label}：探测到的模型不可用于对话，已使用 CC Switch 里声明的模型`;
      }
    } else {
      warning = `${entry.candidate.label}：探测失败（${discovery.error ?? "未知错误"}），已使用 CC Switch 里声明的模型`;
    }
  } catch (error) {
    warning = `${entry.candidate.label}：探测失败（${error instanceof Error ? error.message : String(error)}），已使用声明的模型`;
  }

  const defaultModel = models.some((model) => model.id === entry.candidate.defaultModel)
    ? entry.candidate.defaultModel
    : models[0]!.id;

  return {
    resolved: {
      ...entry,
      baseUrl,
      apiFormat: entry.candidate.apiFormat,
      models: models.map((model) => ({ ...model, isDefault: model.id === defaultModel })),
      defaultModel,
      probed,
    },
    ...(warning ? { warning } : {}),
  };
}

export async function resolveImportPlan(
  plan: ImportPlan,
  options: { validate: boolean; discover?: DiscoverFn },
): Promise<{ entries: ResolvedImport[]; warnings: string[] }> {
  if (!options.validate) {
    return {
      entries: plan.entries.map((entry) => ({
        ...entry,
        baseUrl: entry.candidate.baseUrl,
        apiFormat: entry.candidate.apiFormat,
        models: declaredModels(entry.candidate),
        defaultModel: entry.candidate.defaultModel,
        probed: false,
      })),
      warnings: [],
    };
  }

  const discover = options.discover ?? discoverAiApiModels;
  const entries: ResolvedImport[] = [];
  const warnings: string[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < plan.entries.length) {
      const index = cursor;
      cursor += 1;
      const entry = plan.entries[index]!;
      const { resolved, warning } = await resolveEntry(entry, discover);
      entries[index] = resolved;
      if (warning) warnings.push(warning);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, plan.entries.length) }, worker),
  );

  return { entries: entries.filter(Boolean), warnings };
}

function toProviderDef(resolved: ResolvedImport, existing: ProviderDef | undefined): ProviderDef {
  return {
    id: resolved.providerId,
    label: existing?.label?.trim() || resolved.candidate.label,
    ...(existing?.description ? { description: existing.description } : {}),
    status: "live",
    kind: "api",
    caps: { canFollowUp: true, canCancel: true },
    models: resolved.models,
  };
}

function toConnection(
  resolved: ResolvedImport,
  existing: ProviderConnection | undefined,
): ProviderConnection {
  return {
    providerId: resolved.providerId,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.candidate.apiKey,
    extra: {
      ...(existing?.extra ?? {}),
      kind: "api",
      apiFormat: resolved.apiFormat,
      model: resolved.defaultModel,
      ccSwitch: {
        appType: resolved.candidate.appType,
        id: resolved.candidate.sourceId,
        label: resolved.candidate.label,
      },
    },
  };
}

export function buildImportPatch(
  config: GlobalConfig,
  resolved: ResolvedImport[],
): { patch: UpdateGlobalConfigRequest; actions: CcSwitchImportAction[] } {
  const providers = [...config.providers];
  const connections: Record<string, ProviderConnection> = {};
  const actions: CcSwitchImportAction[] = [];

  for (const entry of resolved) {
    const existingProvider = providers.find((provider) => provider.id === entry.providerId);
    const providerDef = toProviderDef(entry, entry.targetProviderId ? existingProvider : undefined);
    const index = providers.findIndex((provider) => provider.id === entry.providerId);
    if (index >= 0) providers[index] = providerDef;
    else providers.push(providerDef);

    connections[entry.providerId] = toConnection(
      entry,
      entry.targetProviderId ? config.providerConnections[entry.providerId] : undefined,
    );
    actions.push({
      providerId: entry.providerId,
      label: providerDef.label,
      action: entry.action,
    });
  }

  const patch: UpdateGlobalConfigRequest = { providers, providerConnections: connections };

  const currentDefault = config.defaultApiProviderId;
  const currentDefaultConfigured = Boolean(
    config.providerConnections[currentDefault]?.apiKey ??
      config.providerConnections[currentDefault]?.apiKeyMasked,
  );
  const fallbackDefault = resolved[0]?.providerId;
  if (!currentDefaultConfigured && fallbackDefault)
    patch.defaultApiProviderId = fallbackDefault;

  return { patch, actions };
}

export interface ImportCcSwitchOptions {
  config: GlobalConfig;
  records: CcSwitchProviderRecord[];
  /** Candidate keys from the preview; unknown keys are ignored. */
  keys: string[];
  policy?: CcSwitchConflictPolicy;
  validate?: boolean;
  discover?: DiscoverFn;
}

export interface ImportCcSwitchResult {
  patch: UpdateGlobalConfigRequest;
  imported: CcSwitchImportAction[];
  skipped: CcSwitchImportAction[];
  warnings: string[];
}

export async function importCcSwitchProviders(
  options: ImportCcSwitchOptions,
): Promise<ImportCcSwitchResult> {
  const { candidates } = mapCcSwitchRecords(options.records);
  const requested = new Set(options.keys);
  const selected = candidates.filter((candidate) => requested.has(candidate.key));

  const missing = [...requested].filter(
    (key) => !candidates.some((candidate) => candidate.key === key),
  );
  const plan = planImport(options.config, selected, options.policy ?? "skip");
  const { entries, warnings: resolveWarnings } = await resolveImportPlan(plan, {
    validate: options.validate ?? true,
    ...(options.discover ? { discover: options.discover } : {}),
  });
  const { patch, actions } = buildImportPatch(options.config, entries);

  const warnings = [
    ...selected.flatMap((candidate) => candidate.warnings),
    ...resolveWarnings,
    ...missing.map((key) => `${key}：找不到对应的 CC Switch 供应商，已跳过`),
  ];

  return { patch, imported: actions, skipped: plan.skipped, warnings };
}
