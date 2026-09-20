import { createHash } from "node:crypto";
import { getRawSqlite } from "../db/index.js";
import {
  getGlobalConfig,
  getProjectConfig,
} from "../lib/config/config-store.js";

export type MetricScalar = number | string | boolean;
export interface ProviderMetricField {
  id: string;
  providerId: string;
  path: string;
  label: string;
  type: "number" | "string" | "boolean";
  unit?: string;
  source: "declared" | "observed";
  aggregation: "sum" | "latest";
  visible: boolean;
  accumulate: boolean;
  lastValue?: MetricScalar;
  total?: number;
  count: number;
  lastSeen?: string;
}
interface FieldRow {
  id: string;
  provider_id: string;
  path: string;
  label: string;
  type: ProviderMetricField["type"];
  unit: string;
  source: ProviderMetricField["source"];
  aggregation: ProviderMetricField["aggregation"];
  visible: number;
  accumulate: number;
}
type Declaration = Pick<
  ProviderMetricField,
  "path" | "type" | "label" | "unit" | "aggregation"
>;
const MAX_FIELDS = 64;
const MAX_PROVIDER_FIELDS = 256;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const unsafeKey =
  /(?:__proto__|prototype|constructor|secret|password|credential|authorization|api.?key|access.?token|refresh.?token|bearer|cookie|email|account.?id|profile.?arn)/i;
const standardPaths = new Set([
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
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "promptTokens",
  "completionTokens",
  "reasoningTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "prompt_tokens_details.cached_tokens",
  "prompt_tokens_details.reasoning_tokens",
  "input_tokens_details.cached_tokens",
  "completion_tokens_details.reasoning_tokens",
  "output_tokens_details.reasoning_tokens",
  "cache_creation.ephemeral_5m_input_tokens",
  "cache_creation.ephemeral_1h_input_tokens",
  "inputTokenDetails.noCacheTokens",
  "inputTokenDetails.cacheReadTokens",
  "inputTokenDetails.cacheWriteTokens",
  "outputTokenDetails.textTokens",
  "outputTokenDetails.reasoningTokens",
]);
function safeString(value: unknown, length = 128): value is string {
  return (
    typeof value === "string" &&
    value.length <= length &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    !/(?:secret|password|credential)/i.test(value) &&
    !/(?:bearer\s|sk-[\w-]{8}|eyJ[\w-]{12}|-----BEGIN|https?:\/\/|[\w.-]+@[\w.-]+\.[a-z]{2})/i.test(
      value,
    ) &&
    !/[A-Za-z0-9_+/=-]{48,}/.test(value)
  );
}
function safePath(path: string): boolean {
  const keys = path.split(".");
  return (
    keys[0] === "usage" &&
    keys.length > 1 &&
    keys.length <= 6 &&
    !standardPaths.has(keys.slice(1).join(".")) &&
    keys.every(
      (key) =>
        /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(key) && !unsafeKey.test(key),
    )
  );
}

function normalizeUnit(unit: string): string {
  return /^credits?(?:\(s\))?$/i.test(unit.trim()) ? "credit" : unit.trim();
}

/** A bounded scalar-only projection. Never store raw response bodies or credentials. */
export function extractExtendedUsage(
  value: unknown,
): Record<string, MetricScalar> {
  const fields: Record<string, MetricScalar> = {};
  let inspected = 0;
  const visit = (input: unknown, keys: string[]) => {
    if (
      keys.length > 6 ||
      inspected > 256 ||
      Object.keys(fields).length >= MAX_FIELDS
    )
      return;
    for (const [key, item] of Object.entries(object(input))) {
      if (++inspected > 256 || Object.keys(fields).length >= MAX_FIELDS) break;
      const path = [...keys, key].join(".");
      if (!safePath(path)) continue;
      if (
        typeof item === "number" &&
        Number.isFinite(item) &&
        Math.abs(item) <= Number.MAX_SAFE_INTEGER
      )
        fields[path] = item;
      else if (typeof item === "boolean" || safeString(item))
        fields[path] = item;
      else if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item)
      )
        visit(item, [...keys, key]);
    }
  };
  visit(value, ["usage"]);
  return fields;
}

/** Latest value wins for repeated stream snapshots; missing fields retain prior evidence. */
export function mergeExtendedUsage(
  previous: Record<string, MetricScalar>,
  next: unknown,
): Record<string, MetricScalar> {
  return Object.fromEntries(
    Object.entries({ ...previous, ...extractExtendedUsage(next) }).slice(
      0,
      MAX_FIELDS,
    ),
  );
}

/** Restore the safe projection to SDK usage.raw without changing standard token semantics. */
export function extendedUsageObject(
  fields: Record<string, MetricScalar>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(fields)) {
    if (!safePath(path)) continue;
    const keys = path.split(".").slice(1);
    let parent = result;
    for (const key of keys.slice(0, -1)) {
      if (!parent[key] || typeof parent[key] !== "object") parent[key] = {};
      parent = parent[key] as Record<string, unknown>;
    }
    parent[keys[keys.length - 1]] = value;
  }
  return result;
}

function fieldId(providerId: string, definition: Declaration): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        providerId,
        definition.path,
        definition.type,
        definition.unit ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

function upsertField(
  providerId: string,
  definition: Declaration,
  source: ProviderMetricField["source"],
): string | undefined {
  const db = getRawSqlite();
  const id = fieldId(providerId, definition);
  const existing = db
    .prepare("SELECT id FROM provider_metric_fields WHERE id = ?")
    .get(id);
  if (!existing) {
    const count = db
      .prepare(
        "SELECT COUNT(*) AS count FROM provider_metric_fields WHERE provider_id = ?",
      )
      .get(providerId) as { count: number };
    if (count.count >= MAX_PROVIDER_FIELDS) return undefined;
  }
  db.prepare(
    `INSERT INTO provider_metric_fields (id, provider_id, path, label, type, unit, source, aggregation, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = CASE WHEN excluded.source = 'declared' THEN excluded.label ELSE provider_metric_fields.label END,
      source = CASE WHEN excluded.source = 'declared' THEN 'declared' ELSE provider_metric_fields.source END,
      aggregation = CASE WHEN excluded.source = 'declared' THEN excluded.aggregation ELSE provider_metric_fields.aggregation END`,
  ).run(
    id,
    providerId,
    definition.path,
    definition.label,
    definition.type,
    definition.unit ?? "",
    source,
    definition.aggregation,
    new Date().toISOString(),
  );
  return id;
}

export function declareProviderMetrics(
  providerId: string,
  payload: unknown,
): void {
  const schema = object(payload);
  if (schema.version !== 1 || !Array.isArray(schema.fields))
    throw new Error("Unsupported usage schema");
  const fields = schema.fields;
  getRawSqlite().transaction(() => {
    for (const value of fields.slice(0, MAX_FIELDS)) {
      const field = object(value);
      if (
        typeof field.path !== "string" ||
        !safePath(field.path) ||
        !["number", "string", "boolean"].includes(String(field.type))
      )
        continue;
      upsertField(
        providerId,
        {
          path: field.path,
          type: field.type as Declaration["type"],
          label:
            safeString(field.label) && field.label
              ? field.label
              : field.path.slice(6),
          ...(safeString(field.unit, 32) && field.unit
            ? { unit: normalizeUnit(field.unit) }
            : {}),
          aggregation:
            field.type === "number" && field.aggregation === "sum"
              ? "sum"
              : "latest",
        },
        "declared",
      );
    }
  })();
}

function observedUnit(
  path: string,
  values: Record<string, MetricScalar>,
): string | undefined {
  const segments = path.split(".");
  const leaf = segments.pop()!;
  const prefix = segments.join(".");
  const stem = leaf.replace(/_(?:usage|cost|count|used|amount|value)$/, "");
  for (const key of [
    `${prefix}.${leaf}_unit`,
    `${prefix}.${stem}_unit`,
    `${prefix}.unit`,
  ]) {
    const candidate = values[key];
    if (safeString(candidate, 32) && candidate) return normalizeUnit(candidate);
  }
  return undefined;
}

export function observeProviderMetrics(input: {
  providerId: string;
  requestId: string;
  sessionId?: string;
  values: Record<string, MetricScalar>;
  observedAt?: string;
}): void {
  if (
    !input.providerId ||
    !input.requestId ||
    !Object.keys(input.values).length
  )
    return;
  const db = getRawSqlite();
  const observedAt = input.observedAt ?? new Date().toISOString();
  // Transactions make the ledger and samples atomic across concurrent child processes.
  db.transaction(() => {
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO provider_metric_requests (provider_id, request_id, session_id, observed_at) VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.providerId,
        input.requestId,
        input.sessionId ?? "",
        observedAt,
      );
    if (!inserted.changes) return;
    const declared = db
      .prepare(
        "SELECT * FROM provider_metric_fields WHERE provider_id = ? AND source = 'declared' ORDER BY created_at DESC",
      )
      .all(input.providerId) as unknown as FieldRow[];
    for (const [path, value] of Object.entries(input.values).slice(
      0,
      MAX_FIELDS,
    )) {
      if (
        !safePath(path) ||
        !(
          typeof value === "boolean" ||
          safeString(value) ||
          (typeof value === "number" &&
            Number.isFinite(value) &&
            Math.abs(value) <= Number.MAX_SAFE_INTEGER)
        )
      )
        continue;
      const type = typeof value as Declaration["type"];
      const explicitUnit = observedUnit(path, input.values);
      const definition = declared.find(
        (field) =>
          field.path === path &&
          field.type === type &&
          (explicitUnit === undefined || explicitUnit === field.unit),
      );
      const unit =
        type === "number"
          ? (explicitUnit ?? (definition?.unit || undefined))
          : undefined;
      const id = upsertField(
        input.providerId,
        {
          path,
          type,
          label: definition?.label ?? path.slice(6),
          ...(unit ? { unit } : {}),
          aggregation: definition?.aggregation ?? "latest",
        },
        "observed",
      );
      if (!id) continue;
      db.prepare(
        `INSERT OR IGNORE INTO provider_metric_samples (field_id, request_id, session_id, value_json, number_value, observed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.requestId,
        input.sessionId ?? "",
        JSON.stringify(value),
        type === "number" ? (value as number) : null,
        observedAt,
      );
    }
  })();
}

function sessionProviders(sessionId: string): string[] {
  const db = getRawSqlite();
  const ids = db
    .prepare(
      `SELECT DISTINCT provider_id FROM provider_metric_requests WHERE session_id = ?
    UNION SELECT DISTINCT provider_id FROM agent_runtime_messages WHERE session_id = ? AND provider_id IS NOT NULL`,
    )
    .all(sessionId, sessionId) as unknown as { provider_id: string }[];
  const session = db
    .prepare(
      "SELECT project_id, session_metadata_json FROM agent_runtime_sessions WHERE id = ?",
    )
    .get(sessionId) as
    | { project_id: string; session_metadata_json: string }
    | undefined;
  if (session) {
    try {
      const metadata = object(
        JSON.parse(session.session_metadata_json || "{}"),
      );
      const backend = object(metadata.backend);
      const native = object(metadata.nativeBackend);
      const auth = object(native.auth);
      for (const value of [
        metadata.providerId,
        backend.providerId,
        native.providerId,
        auth.providerId,
      ]) {
        if (typeof value === "string") ids.push({ provider_id: value });
      }
      const runs = db
        .prepare(
          "SELECT model FROM agent_runtime_runs WHERE session_id = ? AND model IS NOT NULL ORDER BY started_at DESC",
        )
        .all(sessionId) as unknown as { model: string }[];
      const global = getGlobalConfig();
      const configured = new Set(
        global.providers
          .filter((provider) => provider.kind === "api")
          .map((provider) => provider.id),
      );
      for (const model of [backend.model, ...runs.map((run) => run.model)]) {
        if (typeof model !== "string") continue;
        const prefix = model.split("/")[0];
        if (configured.has(prefix)) ids.push({ provider_id: prefix });
      }
      if ((!backend.id || backend.id === "native") && !ids.length) {
        const project = getProjectConfig(session.project_id);
        const providerId =
          project?.providerId && configured.has(project.providerId)
            ? project.providerId
            : global.defaultApiProviderId;
        if (providerId) ids.push({ provider_id: providerId });
      }
    } catch {
      /* Old sessions may have malformed metadata. */
    }
  }
  return [...new Set(ids.map((row) => row.provider_id))];
}

export function listProviderMetrics(
  scope: { providerId?: string; sessionId?: string } = {},
): ProviderMetricField[] {
  const db = getRawSqlite();
  const providers = scope.providerId
    ? [scope.providerId]
    : scope.sessionId
      ? sessionProviders(scope.sessionId)
      : undefined;
  if (providers?.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT * FROM provider_metric_fields${providers ? ` WHERE provider_id IN (${providers.map(() => "?").join(",")})` : ""} ORDER BY provider_id, path, unit`,
    )
    .all(...(providers ?? [])) as unknown as FieldRow[];
  return rows.map((row) => {
    const args = scope.sessionId ? [row.id, scope.sessionId] : [row.id];
    const condition = `field_id = ?${scope.sessionId ? " AND session_id = ?" : ""}`;
    const aggregate = db
      .prepare(
        `SELECT COUNT(*) AS count, SUM(number_value) AS total FROM provider_metric_samples WHERE ${condition}`,
      )
      .get(...args) as { count: number; total: number | null };
    const latest = db
      .prepare(
        `SELECT value_json, observed_at FROM provider_metric_samples WHERE ${condition} ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
      )
      .get(...args) as { value_json: string; observed_at: string } | undefined;
    return {
      id: row.id,
      providerId: row.provider_id,
      path: row.path,
      label: row.label,
      type: row.type,
      ...(row.unit ? { unit: row.unit } : {}),
      source: row.source,
      aggregation: row.aggregation,
      visible: Boolean(row.visible),
      accumulate: Boolean(row.accumulate),
      count: aggregate.count,
      ...(latest
        ? {
            lastValue: JSON.parse(latest.value_json) as MetricScalar,
            lastSeen: latest.observed_at,
          }
        : {}),
      ...(row.accumulate &&
      row.type === "number" &&
      aggregate.total !== null &&
      Number.isFinite(aggregate.total)
        ? { total: aggregate.total }
        : {}),
    };
  });
}

export function configureProviderMetric(input: {
  id: string;
  visible?: boolean;
  accumulate?: boolean;
}): string {
  const db = getRawSqlite();
  const field = db
    .prepare("SELECT * FROM provider_metric_fields WHERE id = ?")
    .get(input.id) as FieldRow | undefined;
  if (!field) throw new Error("Metric field not found");
  if (input.accumulate && field.type !== "number")
    throw new Error("Only numeric fields can accumulate");
  db.prepare(
    "UPDATE provider_metric_fields SET visible = ?, accumulate = ? WHERE id = ?",
  ).run(
    input.visible === undefined ? field.visible : Number(input.visible),
    input.accumulate === undefined
      ? field.accumulate
      : Number(input.accumulate),
    input.id,
  );
  return field.provider_id;
}
