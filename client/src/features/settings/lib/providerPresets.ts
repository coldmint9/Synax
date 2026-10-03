import type {
  ApiFormat,
  GlobalConfig,
  ProviderConnection,
  ProviderDef,
  ReasoningEffort,
} from "../../../shared/contracts/config";
import type { MediaAdapter, MediaCapabilities, ModelCapability } from "../../../shared/contracts/media-generation";

export type DeclaredModelModality = "text" | "image" | "audio" | "video";

export type ModelMeta = {
  contextLimit?: number;
  inputLimit?: number;
  outputLimit?: number;
  inputModalities?: DeclaredModelModality[];
  outputModalities?: DeclaredModelModality[];
  capabilities?: ModelCapability[];
  media?: MediaCapabilities;
};

export const BUILTIN_API_PROVIDER_IDS = ["openai", "anthropic"] as const;
export const CUSTOM_API_PREFIX = "custom-api:";

/** Wire protocols a provider connection can speak. */
export const API_FORMAT_OPTIONS: { key: ApiFormat; label: string }[] = [
  { key: "openai", label: "OpenAI Chat Completions" },
  { key: "openai-responses", label: "OpenAI Responses" },
  { key: "anthropic", label: "Anthropic Messages" },
  { key: "jev", label: "Jev / TypeSafe System One" },
];

export function apiFormatLabel(format: ApiFormat | string): string {
  return (
    API_FORMAT_OPTIONS.find((option) => option.key === format)?.label ?? format
  );
}

export const ALL_REASONING_EFFORTS: ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "关闭推理",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

export function parseReasoningEfforts(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const configured = new Set(value);
  return ALL_REASONING_EFFORTS.filter((effort) => configured.has(effort));
}

/**
 * Reasoning-effort levels explicitly configured for a provider connection.
 * Returns [] when the provider has no restriction (all levels allowed).
 */
export function providerReasoningEfforts(
  globalConfig: GlobalConfig | null | undefined,
  providerId: string | null | undefined,
): ReasoningEffort[] {
  if (!globalConfig || !providerId) return [];
  const connection = globalConfig.providerConnections?.[providerId];
  if (!connection) return [];
  const listed = parseReasoningEfforts(connection.extra?.reasoningEfforts);
  if (listed.length > 0) return listed;
  const legacy = connection.extra?.defaultReasoningEffort;
  if (
    legacy === "none" ||
    legacy === "low" ||
    legacy === "medium" ||
    legacy === "high" ||
    legacy === "xhigh" ||
    legacy === "max"
  ) {
    return [legacy];
  }
  return [];
}

/** Configured levels, falling back to every level when unrestricted. */
export function effectiveReasoningEfforts(
  globalConfig: GlobalConfig | null | undefined,
  providerId: string | null | undefined,
): ReasoningEffort[] {
  const configured = providerReasoningEfforts(globalConfig, providerId);
  return configured.length > 0 ? configured : ALL_REASONING_EFFORTS;
}

export type ProviderPreset = {
  providerId: string;
  label: string;
  description: string;
  format: ApiFormat;
  defaultBaseUrl: string;
  defaultModel: string;
  allowBaseUrlEdit: boolean;
};

export type ApiProviderDraft = {
  id: string;
  label: string;
  description: string;
  format: ApiFormat;
  mediaAdapter?: MediaAdapter;
  baseUrl: string;
  apiKey: string;
  apiKeyMasked: string;
  model: string;
  /** Models the user selected for this provider. Only these are persisted. */
  models: string[];
  /**
   * Candidate pool offered by the model picker (discovered models plus the ones
   * already configured). Never persisted: picking a candidate is what adds a model.
   */
  modelOptions: string[];
  /** Per-model input context window metadata keyed by model id. */
  modelMeta: Record<string, ModelMeta>;
  /** Reasoning effort levels allowed for this provider (multi-select). Empty = unrestricted. */
  reasoningEfforts: ReasoningEffort[];
  custom: boolean;
  status: "live" | "experimental" | "inactive";
  showApiKey: boolean;
  discoveringModels: boolean;
  validating: boolean;
  modelMessage: string | null;
  validationMessage: string | null;
};

function normalizedModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .split("/")
    .pop()!
    .replace(/@[a-z0-9._-]+$/i, "")
    .replace(/[-:]\d{4}-\d{2}-\d{2}(?:[-:]\d+)?$/, "");
}

/**
 * Defaults for common model families. These are deliberately provider-neutral:
 * `openai/gpt-4o` and `gpt-4o` receive the same defaults when routed through
 * different providers.
 */
export function defaultModelMeta(modelId: string): ModelMeta {
  const id = normalizedModelId(modelId);
  const imageGeneration =
    /^(?:gpt-image-|chatgpt-image-|dall-e|imagen|flux|ideogram|stable-diffusion|sdxl|sd3|playground)/i.test(
      id,
    );
  const videoGeneration =
    /^(?:sora|veo|kling|seedance|wan(?:2|\-)|hailuo|luma|runway|pika)/i.test(
      id,
    );
  const vision =
    /(?:gpt-4o|gpt-4\.1|gpt-5|claude-(?:3|4)|gemini|qwen.*vl|deepseek-vl|deepseek-flash|pixtral|llama-3\.2.*vision|llama-4|kimi-k2\.5|omni|vision)/i.test(
      id,
    );

  if (imageGeneration) {
    return {
      inputModalities: ["text", "image"],
      outputModalities: ["image"],
      capabilities: ["image_generation"],
      media: { operations: ["text-to-image", "image-to-image"] },
    };
  }

  if (videoGeneration) {
    return {
      inputModalities: ["text", "image"],
      outputModalities: ["video"],
      capabilities: ["video_generation"],
      media: { operations: ["text-to-video", "image-to-video"] },
    };
  }

  return {
    inputModalities: vision ? ["text", "image"] : ["text"],
    outputModalities: ["text"],
    capabilities: ["chat"],
  };
}

/** Explicit model settings win over the provider-neutral defaults. */
export function resolveModelMeta(
  draft: ApiProviderDraft,
  modelId: string,
): ModelMeta {
  return {
    ...defaultModelMeta(modelId),
    ...(draft.modelMeta?.[modelId] ?? {}),
  };
}

export const API_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    providerId: "openai",
    label: "OpenAI",
    description: "OpenAI API",
    format: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    allowBaseUrlEdit: true,
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    description: "Anthropic Messages API",
    format: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-3-5-sonnet-latest",
    allowBaseUrlEdit: true,
  },
  {
    providerId: "custom-api:deepseek",
    label: "DeepSeek",
    description: "DeepSeek OpenAI-compatible API",
    format: "openai",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    allowBaseUrlEdit: true,
  },
  {
    providerId: "custom-api:openrouter",
    label: "OpenRouter",
    description: "OpenRouter OpenAI-compatible API",
    format: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    allowBaseUrlEdit: true,
  },
  {
    providerId: "custom-api:ark",
    label: "ByteDance / Ark",
    description: "ByteDance ModelArk OpenAI-compatible API",
    format: "openai",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "seedance-2.0",
    allowBaseUrlEdit: true,
  },
  {
    providerId: "custom-api:minimax",
    label: "MiniMax",
    description: "MiniMax media API",
    format: "openai",
    defaultBaseUrl: "https://api.minimax.io",
    defaultModel: "MiniMax-H3",
    allowBaseUrlEdit: true,
  },
  {
    providerId: "custom-api:xai",
    label: "xAI",
    description: "xAI OpenAI-compatible API",
    format: "openai",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-2-latest",
    allowBaseUrlEdit: true,
  },
];

export const PRESET_BY_PROVIDER_ID = new Map(
  API_PROVIDER_PRESETS.map((p) => [p.providerId, p]),
);

/**
 * Human-readable provider name for model pickers.
 *
 * Provider ids are internal — custom connections look like
 * `custom-api:1790651255292` — so selection UI must resolve the configured
 * label instead of falling back to printing the id.
 */
export function providerDisplayLabel(
  providers: Pick<ProviderDef, "id" | "label">[] | undefined,
  providerId: string | null | undefined,
): string | null {
  if (!providerId) return null;
  const label = providers
    ?.find((provider) => provider.id === providerId)
    ?.label?.trim();
  if (label) return label;
  return PRESET_BY_PROVIDER_ID.get(providerId)?.label ?? null;
}

/** Model option label (`Provider · Model`), degrading to the model name alone. */
export function modelOptionLabel(
  providers: Pick<ProviderDef, "id" | "label">[] | undefined,
  providerId: string | null | undefined,
  modelLabel: string,
): string {
  const provider = providerDisplayLabel(providers, providerId);
  return provider ? `${provider} · ${modelLabel}` : modelLabel;
}

export const PROVIDER_LOGO_ASSETS: Record<
  string,
  { src: string; invertOnDark?: boolean }
> = {
  openai: { src: "/provider-logos/openai.svg", invertOnDark: true },
  anthropic: { src: "/provider-logos/anthropic.svg" },
  "custom-api:deepseek": { src: "/provider-logos/deepseek.png" },
  "custom-api:openrouter": {
    src: "/provider-logos/openrouter.svg",
    invertOnDark: true,
  },
  "custom-api:ark": { src: "/provider-logos/volcengine.svg" },
  "custom-api:minimax": { src: "/provider-logos/minimax.svg" },
  "custom-api:xai": { src: "/provider-logos/xai.ico", invertOnDark: true },
};

export function defaultBaseUrl(format: ApiFormat) {
  return format === "anthropic"
    ? "https://api.anthropic.com/v1"
    : format === "jev"
      ? "https://openrouter.ai/api"
    : "https://api.openai.com/v1";
}

export function defaultModel(format: ApiFormat) {
  if (format === "anthropic") return "claude-3-5-sonnet-latest";
  if (format === "jev") return "jev-latest";
  return "gpt-4o-mini";
}

function defaultBaseUrlForDraft(draft: ApiProviderDraft, format: ApiFormat): string {
  if (draft.id.includes("openrouter")) {
    return format === "jev"
      ? "https://openrouter.ai/api"
      : "https://openrouter.ai/api/v1";
  }
  return defaultBaseUrl(format);
}

function defaultModelForDraft(draft: ApiProviderDraft, format: ApiFormat): string {
  if (format === "jev") return "jev-latest";
  if (draft.id.includes("openrouter")) return "openai/gpt-4o-mini";
  return defaultModel(format);
}

/**
 * Switch protocol while keeping user input: only untouched defaults
 * (empty values or the previous protocol's default) follow the new protocol.
 */
export function applyProtocolDefaults(
  draft: ApiProviderDraft,
  next: ApiFormat,
): ApiProviderDraft {
  if (draft.format === next) return draft;
  const baseUrl =
    !draft.baseUrl.trim() ||
    draft.baseUrl.trim() === defaultBaseUrlForDraft(draft, draft.format)
      ? defaultBaseUrlForDraft(draft, next)
      : draft.baseUrl;
  const model = draft.custom
    ? draft.model
    : !draft.model.trim() || draft.model.trim() === defaultModelForDraft(draft, draft.format)
      ? defaultModelForDraft(draft, next)
      : draft.model;
  return { ...draft, format: next, baseUrl, model };
}

export function isBuiltinApiProviderId(id: string): boolean {
  return id === "openai" || id === "anthropic";
}

export function isConfiguredProvider(draft: ApiProviderDraft): boolean {
  return Boolean(draft.apiKey.trim() || draft.apiKeyMasked.trim());
}

export function normalizeModelList(models: string[], model: string): string[] {
  const merged = [...models];
  if (model && !merged.includes(model)) merged.unshift(model);
  return Array.from(new Set(merged.map((s) => s.trim()).filter(Boolean)));
}

/** Ordered, de-duplicated union of model ids (used for picker candidates). */
export function mergeModelOptions(
  ...lists: Array<string[] | undefined>
): string[] {
  return Array.from(
    new Set(
      lists
        .flatMap((list) => list ?? [])
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

/**
 * Models the current draft would configure: the selected ones plus the default
 * model, which is always part of the provider definition.
 */
export function configuredModelList(draft: ApiProviderDraft): string[] {
  return mergeModelOptions(draft.models, [draft.model]);
}

/**
 * Selected models that carry their own input context window, in selection order.
 * Each model owns its `contextLimit`, so one provider can mix 1M and catalog windows.
 */
export function modelsWithContextLimit(
  draft: ApiProviderDraft,
): Array<{ id: string; contextLimit: number }> {
  const out: Array<{ id: string; contextLimit: number }> = [];
  for (const id of configuredModelList(draft)) {
    const contextLimit = draft.modelMeta?.[id]?.contextLimit;
    if (typeof contextLimit === "number" && contextLimit > 0)
      out.push({ id, contextLimit });
  }
  return out;
}

/**
 * Multi-select toggle for a model picker candidate. The default model stays
 * configured while it is the default; pick another default to drop it.
 */
export function toggleModelSelection(
  draft: ApiProviderDraft,
  candidate: string,
): ApiProviderDraft {
  const model = candidate.trim();
  if (!model || model === draft.model) return draft;
  if (draft.models.includes(model)) {
    return { ...draft, models: draft.models.filter((item) => item !== model) };
  }
  return { ...draft, models: mergeModelOptions(draft.models, [model]) };
}

/** Make `candidate` the default model used for connection checks, keeping it configured. */
export function selectDefaultModel(
  draft: ApiProviderDraft,
  candidate: string,
): ApiProviderDraft {
  const model = candidate.trim();
  if (!model || model === draft.model) return draft;
  return { ...draft, model, models: mergeModelOptions(draft.models, [model]) };
}

/**
 * Turns the 1M input window on or off for one selected model. Passing `false`
 * drops that model's override so it falls back to its catalog declaration, while
 * every other model keeps whatever window it was configured with.
 */
export function toggleModelContextLimit(
  draft: ApiProviderDraft,
  modelId: string,
  enabled: boolean,
  contextLimit = 1_000_000,
): ApiProviderDraft {
  const model = modelId.trim();
  if (!model) return draft;
  return {
    ...draft,
    modelMeta: {
      ...draft.modelMeta,
      [model]: {
        ...(draft.modelMeta?.[model] ?? {}),
        contextLimit: enabled ? contextLimit : undefined,
      },
    },
  };
}

export function resolveFormat(
  providerId: string,
  connection?: ProviderConnection,
): ApiFormat {
  const raw = connection?.extra?.apiFormat;
  if (raw === "anthropic") return "anthropic";
  if (raw === "openai-responses") return "openai-responses";
  if (raw === "openai") return "openai";
  return (
    PRESET_BY_PROVIDER_ID.get(providerId)?.format ??
    (providerId === "anthropic" ? "anthropic" : "openai")
  );
}

export function resolveModel(
  provider: ProviderDef,
  connection: ProviderConnection | undefined,
  format: ApiFormat,
): string {
  const model =
    typeof connection?.extra?.model === "string"
      ? connection.extra.model.trim()
      : "";
  if (model) return model;
  const presetModel = PRESET_BY_PROVIDER_ID.get(provider.id)?.defaultModel;
  if (presetModel) return presetModel;
  const defaultProviderModel =
    provider.models.find((m) => m.isDefault)?.id ?? provider.models[0]?.id;
  if (defaultProviderModel) return defaultProviderModel;
  return isBuiltinApiProviderId(provider.id) ? defaultModel(format) : "";
}

export function fallbackBuiltinApiProvider(
  providerId: "openai" | "anthropic",
): ProviderDef {
  const preset = PRESET_BY_PROVIDER_ID.get(providerId);
  const format: ApiFormat =
    preset?.format ?? (providerId === "anthropic" ? "anthropic" : "openai");
  const model = preset?.defaultModel ?? defaultModel(format);
  return {
    id: providerId,
    label: preset?.label ?? providerId,
    description: preset?.description,
    status: "live",
    kind: "api",
    caps: { canFollowUp: true, canCancel: true },
    models: [{ id: model, label: model, isDefault: true }],
  };
}

export function buildApiDrafts(
  globalConfig: GlobalConfig,
  providers: ProviderDef[],
): ApiProviderDraft[] {
  const providerMap = new Map<string, ProviderDef>();
  for (const provider of providers) {
    if (provider.kind === "api") providerMap.set(provider.id, provider);
  }
  for (const id of BUILTIN_API_PROVIDER_IDS) {
    if (!providerMap.has(id))
      providerMap.set(id, fallbackBuiltinApiProvider(id));
  }
  const sorted = Array.from(providerMap.values()).sort((a, b) => {
    const ap = PRESET_BY_PROVIDER_ID.has(a.id);
    const bp = PRESET_BY_PROVIDER_ID.has(b.id);
    if (ap && !bp) return -1;
    if (!ap && bp) return 1;
    return a.label.localeCompare(b.label);
  });
  return sorted.map((provider) => {
    const preset = PRESET_BY_PROVIDER_ID.get(provider.id);
    const connection = globalConfig.providerConnections[provider.id];
    const format = resolveFormat(provider.id, connection);
    const model = resolveModel(provider, connection, format);
    return {
      id: provider.id,
      label: provider.label || preset?.label || provider.id,
      description: provider.description ?? preset?.description ?? "",
      format,
      mediaAdapter: connection?.mediaAdapter,
      baseUrl:
        connection?.baseUrl ?? preset?.defaultBaseUrl ?? defaultBaseUrl(format),
      apiKey: "",
      apiKeyMasked: connection?.apiKeyMasked ?? "",
      model,
      models: normalizeModelList(
        provider.models.map((m) => m.id),
        model,
      ),
      modelOptions: normalizeModelList(
        provider.models.map((m) => m.id),
        model,
      ),
      modelMeta: Object.fromEntries(
        provider.models
          .filter(
            (m) =>
              typeof m.contextLimit === "number" ||
              m.inputModalities ||
              m.outputModalities ||
              m.capabilities ||
              m.media,
          )
          .map((m) => [
            m.id,
            {
              contextLimit: m.contextLimit,
              inputModalities: m.inputModalities?.filter(
                (modality) => modality !== "file",
              ),
              outputModalities: m.outputModalities?.filter(
                (modality) => modality !== "file",
              ),
              capabilities: m.capabilities,
              media: m.media,
            },
          ]),
      ),
      reasoningEfforts: providerReasoningEfforts(globalConfig, provider.id),
      custom: !preset,
      status: provider.status,
      showApiKey: false,
      discoveringModels: false,
      validating: false,
      modelMessage: null,
      validationMessage: null,
    };
  });
}

export function createDraftFromPreset(
  preset: ProviderPreset,
): ApiProviderDraft {
  return {
    id: preset.providerId,
    label: preset.label,
    description: preset.description,
    format: preset.format,
    baseUrl: preset.defaultBaseUrl,
    apiKey: "",
    apiKeyMasked: "",
    model: preset.defaultModel,
    models: [preset.defaultModel],
    modelOptions: [preset.defaultModel],
    modelMeta: {},
    reasoningEfforts: [],
    custom: false,
    status: "live",
    showApiKey: false,
    discoveringModels: false,
    validating: false,
    modelMessage: null,
    validationMessage: null,
  };
}

export function createCustomDraft(
  existing: ApiProviderDraft[],
): ApiProviderDraft {
  const count = existing.filter((d) => d.custom).length + 1;
  return {
    id: `${CUSTOM_API_PREFIX}${Date.now()}`,
    label: `Custom API ${count}`,
    description: "",
    format: "openai",
    baseUrl: "",
    apiKey: "",
    apiKeyMasked: "",
    model: "",
    models: [],
    modelOptions: [],
    modelMeta: {},
    reasoningEfforts: [],
    custom: true,
    status: "live",
    showApiKey: false,
    discoveringModels: false,
    validating: false,
    modelMessage: null,
    validationMessage: null,
  };
}

export function draftToProviderDef(draft: ApiProviderDraft): ProviderDef {
  return {
    id: draft.id,
    label: draft.label.trim() || draft.id,
    description: draft.description.trim() || undefined,
    status: draft.status,
    kind: "api",
    caps: { canFollowUp: true, canCancel: true },
    models: normalizeModelList(draft.models, draft.model).map((id) => {
      const meta = resolveModelMeta(draft, id);
      return {
        id,
        label: id,
        isDefault: id === draft.model,
        ...(meta.inputModalities ? { inputModalities: meta.inputModalities } : {}),
        ...(meta.outputModalities ? { outputModalities: meta.outputModalities } : {}),
        ...(meta.contextLimit ? { contextLimit: meta.contextLimit } : {}),
        ...(meta.capabilities ? { capabilities: meta.capabilities } : {}),
        ...(meta.media ? { media: meta.media } : {}),
      };
    }),
  };
}

export function draftToConnection(draft: ApiProviderDraft): ProviderConnection {
  return {
    providerId: draft.id,
    mediaAdapter: draft.mediaAdapter ?? (draft.id === "openai" ? "openai" : draft.id.includes("openrouter") ? "openrouter" : draft.id.includes("xai") ? "xai" : draft.id.includes("ark") ? "ark" : draft.id.includes("minimax") ? "minimax" : undefined),
    baseUrl: draft.baseUrl || undefined,
    apiKey: draft.apiKey || undefined,
    apiKeyMasked: draft.apiKey ? undefined : draft.apiKeyMasked || undefined,
    extra: {
      kind: "api",
      apiFormat: draft.format,
      model: draft.model || undefined,
      ...(draft.reasoningEfforts?.length
        ? { reasoningEfforts: parseReasoningEfforts(draft.reasoningEfforts) }
        : {}),
    },
  };
}

export function upsertDraft(
  drafts: ApiProviderDraft[],
  draft: ApiProviderDraft,
): ApiProviderDraft[] {
  const existing = drafts.find((d) => d.id === draft.id);
  const mergedMeta: ApiProviderDraft["modelMeta"] = {
    ...(existing?.modelMeta ?? {}),
    ...(draft.modelMeta ?? {}),
  };
  const normalized = {
    ...draft,
    label: draft.label.trim() || draft.id,
    model: draft.model.trim(),
    models: normalizeModelList(draft.models, draft.model.trim()),
    modelOptions: mergeModelOptions(
      existing?.modelOptions,
      draft.modelOptions,
      draft.models,
      [draft.model],
    ),
    modelMeta: mergedMeta,
    reasoningEfforts:
      draft.reasoningEfforts ?? existing?.reasoningEfforts ?? [],
  };
  if (drafts.some((d) => d.id === normalized.id)) {
    return drafts.map((d) => (d.id === normalized.id ? normalized : d));
  }
  return [...drafts, normalized];
}
