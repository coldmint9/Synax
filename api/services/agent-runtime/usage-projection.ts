import { getRawSqlite } from "../../db/index.js";
import { readUsageContextWindowSize } from "./acp-engine/acp-usage.js";
import {
  normalizeUsage,
  isTokenCount,
  type NormalizedUsage,
  type UsageContext,
} from "../llm-runtime/usage.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";

export interface UsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cacheReadMatched: number;
  cacheInputMatched: number;
  cacheReadRatio: number | null;
}
export interface UsageCoverage {
  requests: number;
  recorded: number;
  missing: number;
  complete: boolean;
  cacheReadKnown: number;
  cacheReadUnknown: number;
  cacheWriteKnown: number;
  cacheWriteUnknown: number;
  cacheMatched: number;
}
type Groups<T> = { self: T; tree: T };
export interface SessionUsageProjection {
  context: {
    inputTokens: number | null;
    requestId: string | null;
    measuredAt: string | null;
    latestRequestUsageAvailable: boolean;
  };
  // self/tree retain cumulative compatibility, including auxiliary calls. The
  // explicit subgroups distinguish model steps from non-step auxiliary calls.
  usage: Groups<UsageTotals> & {
    steps: Groups<UsageTotals>;
    auxiliary: Groups<UsageTotals>;
  };
  coverage: Groups<UsageCoverage> & {
    steps: Groups<UsageCoverage>;
    auxiliary: Groups<UsageCoverage>;
  };
  durationMs: number;
  reportedWindow: number | null;
}
const zero = (): UsageTotals => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cacheReadMatched: 0,
  cacheInputMatched: 0,
  cacheReadRatio: null,
});
const emptyCoverage = (): UsageCoverage => ({
  requests: 0,
  recorded: 0,
  missing: 0,
  complete: true,
  cacheReadKnown: 0,
  cacheReadUnknown: 0,
  cacheWriteKnown: 0,
  cacheWriteUnknown: 0,
  cacheMatched: 0,
});
const groups = <T>(create: () => T): Groups<T> => ({
  self: create(),
  tree: create(),
});
function parse(raw: string | null): Record<string, any> | null {
  try {
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
function hasUsage(u: NormalizedUsage | undefined): boolean {
  return (
    !!u &&
    (isTokenCount(u.totalTokens) ||
      (
        ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const
      ).some((key) => u.normalization[key].status === "known"))
  );
}
export function projectSessionUsage(
  sessionId: string,
  treeIds: string[],
): SessionUsageProjection {
  const ids = [...new Set([sessionId, ...treeIds])];
  const db = getRawSqlite();
  const slots = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.rowid AS sequence, s.id, s.session_id, s.started_at, s.completed_at, s.status, s.metadata_json, r.completed_at AS run_ended_at FROM agent_runtime_run_steps s JOIN agent_runtime_runs r ON r.id=s.run_id WHERE s.session_id IN (${slots}) ORDER BY s.started_at, s.rowid`,
    )
    .all(...ids) as Array<{
    sequence: number;
    id: string;
    session_id: string;
    started_at: string;
    completed_at: string | null;
    run_ended_at: string | null;
    status: string;
    metadata_json: string;
  }>;
  const auxiliary = db
    .prepare(
      `SELECT * FROM agent_runtime_aux_usage WHERE session_id IN (${slots})`,
    )
    .all(...ids) as Array<{ session_id: string; usage_json: string | null }>;
  const result: SessionUsageProjection = {
    context: {
      inputTokens: null,
      requestId: null,
      measuredAt: null,
      latestRequestUsageAvailable: false,
    },
    usage: { ...groups(zero), steps: groups(zero), auxiliary: groups(zero) },
    coverage: {
      ...groups(emptyCoverage),
      steps: groups(emptyCoverage),
      auxiliary: groups(emptyCoverage),
    },
    durationMs: 0,
    reportedWindow: null,
  };
  const add = (
    id: string,
    u: NormalizedUsage | undefined,
    kind: "steps" | "auxiliary",
  ) => {
    for (const group of id === sessionId
      ? (["self", "tree"] as const)
      : (["tree"] as const)) {
      for (const bucket of [
        result,
        { usage: result.usage[kind], coverage: result.coverage[kind] },
      ]) {
        const coverage = bucket.coverage[group];
        coverage.requests++;
        const n = u?.normalization;
        for (const key of ["cacheRead", "cacheWrite"] as const)
          coverage[
            `${key}${n?.[key].status === "known" ? "Known" : "Unknown"}`
          ]++;
        if (!hasUsage(u)) {
          coverage.missing++;
          coverage.complete = false;
          continue;
        }
        coverage.recorded++;
        const total = bucket.usage[group];
        total.input += n!.input.value ?? 0;
        total.output += n!.output.value ?? 0;
        total.reasoning += n!.reasoning.value ?? 0;
        total.cacheRead += n!.cacheRead.value ?? 0;
        total.cacheWrite += n!.cacheWrite.value ?? 0;
        if (n!.cacheRead.status === "known" && n!.input.status === "known") {
          coverage.cacheMatched++;
          total.cacheReadMatched += n!.cacheRead.value!;
          total.cacheInputMatched += n!.input.value!;
          total.cacheReadRatio =
            total.cacheInputMatched > 0
              ? total.cacheReadMatched / total.cacheInputMatched
              : null;
        }
        total.total = total.input + total.output;
      }
    }
  };
  for (const row of rows) {
    const metadata = parse(row.metadata_json);
    const context: UsageContext = {
      providerMetadata: metadata?.providerMetadata,
    };
    if (
      metadata?.backendId === "codex" ||
      metadata?.backendId === "claude-code"
    )
      context.source = "cli";
    else if (metadata?.engine === "acp") context.source = "acp";
    const u = normalizeUsage(metadata?.usage, context);
    const contextUsage = metadata?.externalTurn
      ? normalizeUsage(metadata.contextUsage, context)
      : u;
    add(row.session_id, u, "steps");
    if (row.session_id !== sessionId) continue;
    const start = Date.parse(row.started_at);
    const end = row.completed_at ?? row.run_ended_at;
    result.durationMs +=
      Math.max(
        0,
        (end
          ? Date.parse(end)
          : ["running", "waiting_permission", "waiting_input"].includes(
                row.status,
              )
            ? Date.now()
            : start) - start,
      ) || 0;
    result.context.latestRequestUsageAvailable =
      contextUsage?.normalization.input.status === "known";
    if (result.context.latestRequestUsageAvailable) {
      result.context.inputTokens = contextUsage!.normalization.input.value!;
      result.context.requestId =
        typeof contextUsage!.requestId === "string"
          ? contextUsage!.requestId
          : row.id;
      result.context.measuredAt =
        typeof contextUsage!.measuredAt === "string"
          ? contextUsage!.measuredAt
          : (row.completed_at ?? row.started_at);
    }
    if (contextUsage)
      result.reportedWindow =
        readUsageContextWindowSize(contextUsage) ?? result.reportedWindow;
  }
  for (const row of auxiliary)
    add(row.session_id, normalizeUsage(parse(row.usage_json)), "auxiliary");
  return result;
}

/** Auxiliary calls have their own ID, never reuse a step ID or add their usage to step usage. */
export function startAuxUsage(
  sessionId: string,
  purpose: string,
  runId?: string | null,
): string {
  const id = makeRuntimeId("aux");
  getRawSqlite()
    .prepare(
      "INSERT INTO agent_runtime_aux_usage (id, session_id, run_id, purpose, started_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, sessionId, runId ?? null, purpose, nowIso());
  return id;
}
export function finishAuxUsage(id: string, usage?: unknown): void {
  getRawSqlite()
    .prepare(
      "UPDATE agent_runtime_aux_usage SET completed_at=?, usage_json=? WHERE id=?",
    )
    .run(nowIso(), usage ? JSON.stringify(normalizeUsage(usage)) : null, id);
}
