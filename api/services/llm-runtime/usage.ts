/** Standard token normalization stays separate from bounded extension metrics. */
export interface UsageContext {
  source?: "sdk" | "raw" | "acp" | "cli" | "legacy";
  protocol?: string;
  adapter?: string;
  providerMetadata?: unknown;
  providerId?: string;
  sessionId?: string;
}
export interface UsageMetric {
  status: "known" | "unknown";
  value?: number;
  source: string;
  rawPresent: boolean;
}
export interface UsageNormalization {
  version: 1;
  source: NonNullable<UsageContext["source"]>;
  protocol?: string;
  adapter?: string;
  /** Source input semantics; the normalized input metric is always inclusive. */
  inputSemantics: "total" | "uncached";
  input: UsageMetric;
  output: UsageMetric;
  reasoning: UsageMetric;
  cacheRead: UsageMetric;
  cacheWrite: UsageMetric;
}
export interface NormalizedUsage extends Record<string, unknown> {
  inputTokens?: number;
  promptTokens?: number;
  outputTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  normalization: UsageNormalization;
}
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const owns = (obj: RecordValue, key: string) =>
  Object.prototype.hasOwnProperty.call(obj, key);
export const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const scalarKeys = [
  "input_tokens",
  "output_tokens",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "cached_input_tokens",
  "reasoning_tokens",
];
const nestedKeys: Record<string, string[]> = {
  prompt_tokens_details: ["cached_tokens", "reasoning_tokens"],
  input_tokens_details: ["cached_tokens"],
  completion_tokens_details: ["reasoning_tokens"],
  output_tokens_details: ["reasoning_tokens"],
  cache_creation: ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
};
export function whitelistRawUsage(value: unknown): RecordValue {
  const input = record(value);
  const result: RecordValue = {};
  // Invalid values retain presence, not arbitrary strings/objects from the wire.
  for (const key of scalarKeys)
    if (owns(input, key))
      result[key] = isTokenCount(input[key]) ? input[key] : null;
  for (const [key, children] of Object.entries(nestedKeys)) {
    if (!owns(input, key)) continue;
    const nested = record(input[key]);
    result[key] = Object.fromEntries(
      children
        .filter((child) => owns(nested, child))
        .map((child) => [
          child,
          isTokenCount(nested[child]) ? nested[child] : null,
        ]),
    );
  }
  return result;
}
export function mergeRawUsage(
  previous: RecordValue,
  next: unknown,
): RecordValue {
  const result = { ...previous };
  for (const [key, value] of Object.entries(whitelistRawUsage(next))) {
    result[key] =
      key in nestedKeys
        ? { ...record(previous[key]), ...record(value) }
        : value;
  }
  return result;
}
function field(
  obj: RecordValue,
  paths: string[],
  source: string,
  rawPresent = false,
  ambiguousZero = false,
): UsageMetric {
  for (const path of paths) {
    const keys = path.split(".");
    let parent = obj;
    for (const key of keys.slice(0, -1)) parent = record(parent[key]);
    const key = keys[keys.length - 1];
    if (!owns(parent, key)) continue;
    const value = parent[key];
    return {
      status:
        isTokenCount(value) && !(ambiguousZero && value === 0)
          ? "known"
          : "unknown",
      ...(isTokenCount(value) && !(ambiguousZero && value === 0)
        ? { value }
        : {}),
      source: `${source}:${path}`,
      rawPresent,
    };
  }
  return { status: "unknown", source: "missing", rawPresent: false };
}
function select(
  raw: RecordValue,
  paths: string[],
  sdk: RecordValue,
  aliases: string[],
  source: string,
  ambiguousZero = false,
): UsageMetric {
  const rawField = field(raw, paths, "raw", true);
  return rawField.source !== "missing"
    ? rawField
    : field(sdk, aliases, source, false, ambiguousZero);
}
function sum(
  metrics: UsageMetric[],
  source: string,
  rawPresent = false,
): UsageMetric {
  const value = metrics.reduce(
    (total, metric) => total + (metric.value ?? 0),
    0,
  );
  return metrics.every((metric) => metric.status === "known") &&
    isTokenCount(value)
    ? { status: "known", value, source, rawPresent }
    : { status: "unknown", source, rawPresent };
}
function withAliases(
  original: RecordValue,
  normalization: UsageNormalization,
): NormalizedUsage {
  const { input, output, reasoning, cacheRead, cacheWrite } = normalization;
  return {
    ...original,
    inputTokens: input.value,
    promptTokens: input.value,
    outputTokens: output.value,
    completionTokens: output.value,
    totalTokens:
      sum([input, output], "derived").value ??
      field(
        original,
        ["totalTokens", "total_tokens", "raw.total_tokens"],
        "reported",
      ).value,
    reasoningTokens: reasoning.value,
    cachedInputTokens: cacheRead.value,
    cacheWriteTokens: cacheWrite.value,
    normalization,
  };
}
/** Idempotent across hooks, persisted records, ACP/CLI and legacy projections. */
export function normalizeUsage(
  value: unknown,
  context: UsageContext = {},
): NormalizedUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const u = record(value);
  const existing = record(u.normalization);
  if (
    existing.version === 1 &&
    (
      ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const
    ).every((key) => {
      const metric = record(existing[key]);
      return (
        (metric.status === "known" && isTokenCount(metric.value)) ||
        (metric.status === "unknown" && metric.value === undefined)
      );
    })
  )
    return value as NormalizedUsage;
  const evidence = record(record(context.providerMetadata).synaxUsage);
  const captured = evidence.version === 1;
  const source =
    context.source ??
    (["acp", "cli", "sdk", "raw"].includes(String(u.source))
      ? (u.source as UsageContext["source"])
      : ["codex", "claude-code"].includes(String(u.source))
        ? "cli"
        : captured
          ? "sdk"
          : "legacy")!;
  const protocol =
    context.protocol ??
    (typeof evidence.protocol === "string" ? evidence.protocol : undefined);
  const adapter =
    context.adapter ??
    (typeof evidence.adapter === "string" ? evidence.adapter : undefined);
  // SDK raw may contain synthetic defaults. Captured wire presence is authoritative.
  const raw = captured
    ? whitelistRawUsage(evidence.raw)
    : mergeRawUsage(whitelistRawUsage(u), u.raw);
  // An explicit protocol defines input semantics and standard cache fields.
  // Infer from shape only for older/CLI records with no protocol evidence.
  const anthropic =
    protocol === "anthropic" ||
    protocol === "anthropic-messages" ||
    (protocol === undefined &&
      (owns(raw, "cache_read_input_tokens") ||
        owns(raw, "cache_creation_input_tokens") ||
        owns(raw, "cache_creation")));
  // Responses and Chat may carry both shapes on compatible endpoints. Prefer
  // the resolved protocol's own standard fields, including present zero/invalid.
  // Protocol-less legacy records retain the historical Chat-first fallback.
  const inputPaths =
    protocol === "openai-responses"
      ? ["input_tokens", "prompt_tokens"]
      : ["prompt_tokens", "input_tokens"];
  const readPaths = anthropic
    ? ["cache_read_input_tokens"]
    : [
        ...inputPaths.map((key) => `${key}_details.cached_tokens`),
        "prompt_cache_hit_tokens",
        "cached_input_tokens",
      ];
  const writePaths = ["cache_creation_input_tokens"];
  // Native SDK defaults of zero are not wire evidence; explicit ACP/CLI zero is.
  const ambiguousZero = source === "legacy" || source === "sdk";
  const cacheRead = select(
    raw,
    readPaths,
    u,
    [
      "cachedInputTokens",
      "cachedReadTokens",
      "inputTokenDetails.cacheReadTokens",
      "inputTokens.cacheRead",
    ],
    source,
    ambiguousZero,
  );
  let cacheWrite = select(
    raw,
    writePaths,
    u,
    [
      "cacheWriteTokens",
      "cachedWriteTokens",
      "cacheWriteInputTokens",
      "inputTokenDetails.cacheWriteTokens",
      "inputTokens.cacheWrite",
    ],
    source,
    ambiguousZero,
  );
  if (
    !owns(raw, "cache_creation_input_tokens") &&
    owns(raw, "cache_creation")
  ) {
    cacheWrite = sum(
      nestedKeys.cache_creation.map((key) =>
        field(raw, [`cache_creation.${key}`], "raw", true),
      ),
      "raw:cache_creation",
      true,
    );
  }
  let input = select(
    raw,
    inputPaths,
    u,
    ["inputTokens.total", "inputTokens", "promptTokens", "used"],
    source,
    captured && source === "sdk",
  );
  const inputSemantics =
    anthropic && owns(raw, "input_tokens") ? "uncached" : "total";
  if (inputSemantics === "uncached")
    input = sum(
      [field(raw, ["input_tokens"], "raw", true), cacheRead, cacheWrite],
      "raw:anthropic-total",
      true,
    );
  const output = select(
    raw,
    ["completion_tokens", "output_tokens"],
    u,
    ["outputTokens.total", "outputTokens", "completionTokens"],
    source,
    captured && source === "sdk",
  );
  const reasoning = select(
    raw,
    [
      "completion_tokens_details.reasoning_tokens",
      "output_tokens_details.reasoning_tokens",
      "reasoning_tokens",
    ],
    u,
    [
      "reasoningTokens",
      "thoughtTokens",
      "reasoningOutputTokens",
      "outputTokenDetails.reasoningTokens",
      "outputTokens.reasoning",
    ],
    source,
    captured && source === "sdk",
  );
  return withAliases(
    { ...u, ...(owns(u, "raw") ? { raw: whitelistRawUsage(u.raw) } : {}) },
    {
      version: 1,
      source,
      protocol,
      adapter,
      inputSemantics,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
    },
  );
}
/** Aggregate actual steps, never SDK totalUsage plus the same finish-step usage. */
export function aggregateUsage(
  values: NormalizedUsage[],
): NormalizedUsage | undefined {
  if (!values.length) return undefined;
  if (values.length === 1) return values[0];
  const metrics = Object.fromEntries(
    (["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const).map(
      (key) => [
        key,
        sum(
          values.map((value) => value.normalization[key]),
          "steps",
        ),
      ],
    ),
  ) as Pick<
    UsageNormalization,
    "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite"
  >;
  return withAliases(
    {},
    { version: 1, source: "sdk", inputSemantics: "total", ...metrics },
  );
}

/** Structural subset of a completed SDK result; no dependency on SDK internals. */
export interface UsageResult {
  steps?: ReadonlyArray<{ usage?: unknown; providerMetadata?: unknown }>;
  usage?: unknown;
  totalUsage?: unknown;
  providerMetadata?: unknown;
}

/**
 * Normalize auxiliary calls from their actual steps. SDK totalUsage can discard
 * raw evidence, and result.providerMetadata describes only the final step.
 * Missing samples stay unknown; timing and absent provider identity are not inferred.
 */
export function normalizeResultUsage(
  result: UsageResult,
): NormalizedUsage | undefined {
  if (result.steps?.length) {
    return aggregateUsage(
      result.steps.map((step) => {
        const context: UsageContext = {
          source: "sdk",
          providerMetadata: step.providerMetadata,
        };
        return (
          normalizeUsage(step.usage, context) ?? normalizeUsage({}, context)!
        );
      }),
    );
  }
  // With no steps, explicit single-result usage may use its own metadata.
  // A totals-only fallback must never borrow last-step raw fields.
  return (
    normalizeUsage(result.usage, {
      source: "sdk",
      providerMetadata: result.providerMetadata,
    }) ?? normalizeUsage(result.totalUsage, { source: "sdk" })
  );
}
