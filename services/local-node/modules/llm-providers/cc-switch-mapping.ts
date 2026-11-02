import { parse as parseToml } from "smol-toml";
import { maskSecret } from "../../infrastructure/runtime/config/config-secret.js";
import type { ApiFormat } from "../../infrastructure/runtime/config/config-types.js";
import {
  isSupportedCcSwitchApp,
  type CcSwitchModelCandidate,
  type CcSwitchProviderCandidate,
  type CcSwitchProviderRecord,
  type CcSwitchSkippedProvider,
} from "./cc-switch-contracts.js";

/**
 * Pure mapping from cc-switch's per-CLI `settings_config` payloads to Synax
 * provider candidates. Every CLI stores its own native config format, so each
 * supported app type gets a small dedicated parser.
 */

const ONE_MILLION = 1_000_000;

/** Model env vars Claude Code reads, in preference order. */
const CLAUDE_MODEL_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** cc-switch writes protocol names with underscores; Synax uses dashes. */
export function normalizeCcSwitchApiFormat(value: unknown): ApiFormat | undefined {
  const raw = asString(value).toLowerCase();
  if (!raw) return undefined;
  if (raw === "anthropic") return "anthropic";
  if (raw === "jev") return "jev";
  if (raw === "openai" || raw === "openai_chat" || raw === "openai-chat") return "openai";
  if (raw === "openai_responses" || raw === "openai-responses" || raw === "responses")
    return "openai-responses";
  return undefined;
}

/** Trailing slashes only: the endpoint path itself is meaningful. */
export function normalizeCcSwitchBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** `deepseek-v4-flash[1M]` → `deepseek-v4-flash`. */
export function normalizeCcSwitchModelId(value: string): string {
  return value.trim().replace(/\[1m\]$/i, "").trim();
}

function hasOneMillionMarker(value: string): boolean {
  return /\[1m\]$/i.test(value.trim());
}

function addModel(models: Map<string, CcSwitchModelCandidate>, model: CcSwitchModelCandidate): void {
  const existing = models.get(model.id);
  if (!existing) {
    models.set(model.id, model);
    return;
  }
  if (model.contextLimit && !existing.contextLimit)
    models.set(model.id, { ...existing, contextLimit: model.contextLimit });
}

function claudeModels(env: Record<string, unknown>): CcSwitchModelCandidate[] {
  const models = new Map<string, CcSwitchModelCandidate>();
  for (const key of CLAUDE_MODEL_KEYS) {
    const declared = asString(env[key]);
    if (!declared) continue;
    // cc-switch keeps the `[1M]` suffix on the value and the clean id on *_NAME.
    const named = asString(env[`${key}_NAME`]);
    const id = normalizeCcSwitchModelId(named || declared);
    if (!id) continue;
    addModel(models, {
      id,
      ...(hasOneMillionMarker(declared) || hasOneMillionMarker(named)
        ? { contextLimit: ONE_MILLION }
        : {}),
    });
  }
  return [...models.values()];
}

function codexToml(settingsConfig: Record<string, unknown>): {
  parsed: Record<string, unknown>;
  warning?: string;
} {
  const raw = settingsConfig.config;
  if (typeof raw === "object" && raw) return { parsed: asRecord(raw) };
  const text = asString(raw);
  if (!text) return { parsed: {} };
  try {
    return { parsed: asRecord(parseToml(text)) };
  } catch {
    return { parsed: {}, warning: "cc-switch 里的 codex 配置不是合法 TOML，已跳过其端点信息" };
  }
}

function codexModels(
  settingsConfig: Record<string, unknown>,
  parsed: Record<string, unknown>,
): CcSwitchModelCandidate[] {
  const models = new Map<string, CcSwitchModelCandidate>();
  const catalog = asRecord(settingsConfig.modelCatalog);
  const catalogModels = Array.isArray(catalog.models) ? catalog.models : [];
  for (const entry of catalogModels) {
    const item = asRecord(entry);
    const id = normalizeCcSwitchModelId(asString(item.model) || asString(item.id));
    if (!id) continue;
    const window = item.contextWindow;
    addModel(models, {
      id,
      ...(typeof window === "number" && window > 0 ? { contextLimit: window } : {}),
    });
  }
  const declared = normalizeCcSwitchModelId(asString(parsed.model));
  if (declared) addModel(models, { id: declared });
  return [...models.values()];
}

function mapClaude(
  record: CcSwitchProviderRecord,
): { candidate: CcSwitchProviderCandidate } | { reason: string } {
  const settingsConfig = asRecord(record.settingsConfig);
  const env = asRecord(settingsConfig.env);
  const baseUrl = asString(env.ANTHROPIC_BASE_URL);
  const apiKey = asString(env.ANTHROPIC_AUTH_TOKEN) || asString(env.ANTHROPIC_API_KEY);
  if (!baseUrl) return { reason: "未配置 ANTHROPIC_BASE_URL" };
  if (!apiKey) return { reason: "未配置 ANTHROPIC_AUTH_TOKEN" };

  const models = claudeModels(env);
  if (models.length === 0) return { reason: "未配置模型" };

  const apiFormat = normalizeCcSwitchApiFormat(record.meta.apiFormat) ?? "anthropic";
  const declaredModel = asString(env.ANTHROPIC_MODEL);
  const defaultModel = normalizeCcSwitchModelId(declaredModel) || models[0]!.id;
  if (defaultModel !== models[0]!.id && !models.some((model) => model.id === defaultModel)) {
    models.unshift({ id: defaultModel });
  }

  return {
    candidate: {
      key: `${record.appType}:${record.id}`,
      appType: "claude",
      sourceId: record.id,
      label: record.name.trim() || record.id,
      baseUrl: normalizeCcSwitchBaseUrl(baseUrl),
      apiFormat,
      apiKey,
      apiKeyMasked: maskSecret(apiKey) ?? "****",
      models,
      defaultModel,
      warnings: [],
    },
  };
}

function mapCodex(
  record: CcSwitchProviderRecord,
): { candidate: CcSwitchProviderCandidate } | { reason: string } {
  const settingsConfig = asRecord(record.settingsConfig);
  const auth = asRecord(settingsConfig.auth);
  const apiKey = asString(auth.OPENAI_API_KEY);
  if (!apiKey) return { reason: "未配置 OPENAI_API_KEY" };

  const { parsed, warning } = codexToml(settingsConfig);
  const warnings: string[] = warning ? [warning] : [];
  const providers = asRecord(parsed.model_providers);
  const providerEntries = Object.values(providers).map(asRecord);
  const chosen =
    asRecord(providers.custom) && asString(asRecord(providers.custom).base_url)
      ? asRecord(providers.custom)
      : providerEntries.find((entry) => asString(entry.base_url)) ?? {};
  const baseUrl = asString(chosen.base_url);
  if (!baseUrl) return { reason: "未配置 model_providers base_url" };

  const models = codexModels(settingsConfig, parsed);
  if (models.length === 0) return { reason: "未配置模型" };

  const wireApi = asString(chosen.wire_api).toLowerCase();
  const apiFormat: ApiFormat =
    wireApi === "chat"
      ? "openai"
      : wireApi === "responses"
        ? "openai-responses"
        : normalizeCcSwitchApiFormat(record.meta.apiFormat) ?? "openai-responses";
  const defaultModel = normalizeCcSwitchModelId(asString(parsed.model)) || models[0]!.id;

  return {
    candidate: {
      key: `${record.appType}:${record.id}`,
      appType: "codex",
      sourceId: record.id,
      label: record.name.trim() || record.id,
      baseUrl: normalizeCcSwitchBaseUrl(baseUrl),
      apiFormat,
      apiKey,
      apiKeyMasked: maskSecret(apiKey) ?? "****",
      models,
      defaultModel,
      warnings,
    },
  };
}

function mapRecord(
  record: CcSwitchProviderRecord,
): { candidate: CcSwitchProviderCandidate } | { reason: string } {
  if (record.appType === "claude") return mapClaude(record);
  if (record.appType === "codex") return mapCodex(record);
  return { reason: "暂不支持该 CLI" };
}

function isOfficial(record: CcSwitchProviderRecord): boolean {
  return (
    record.category === "official" ||
    record.meta.category === "official" ||
    record.meta.isOfficial === true
  );
}

export interface CcSwitchMappingResult {
  candidates: CcSwitchProviderCandidate[];
  skipped: CcSwitchSkippedProvider[];
  unsupported: CcSwitchSkippedProvider[];
}

export function mapCcSwitchRecords(
  records: CcSwitchProviderRecord[],
): CcSwitchMappingResult {
  const candidates: CcSwitchProviderCandidate[] = [];
  const skipped: CcSwitchSkippedProvider[] = [];
  const unsupported: CcSwitchSkippedProvider[] = [];
  const seenKeys = new Set<string>();

  for (const record of records) {
    const key = `${record.appType}:${record.id}`;
    const label = record.name.trim() || record.id;
    if (!isSupportedCcSwitchApp(record.appType)) {
      unsupported.push({ key, appType: record.appType, label, reason: "暂不支持该 CLI" });
      continue;
    }
    // Official entries only bind a CLI to its vendor login; they carry no key.
    if (isOfficial(record)) {
      skipped.push({ key, appType: record.appType, label, reason: "官方登录项，无需导入" });
      continue;
    }

    const mapped = mapRecord(record);
    if ("reason" in mapped) {
      skipped.push({ key, appType: record.appType, label, reason: mapped.reason });
      continue;
    }
    if (seenKeys.has(mapped.candidate.key)) continue;
    seenKeys.add(mapped.candidate.key);
    candidates.push(mapped.candidate);
  }

  return { candidates, skipped, unsupported };
}
