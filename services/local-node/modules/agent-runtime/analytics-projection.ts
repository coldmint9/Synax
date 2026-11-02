import { normalizeUsage } from "../../infrastructure/llm-runtime/usage.js";
import type {
  AgentRun,
  AgentRunStep,
  AgentRuntimeMessage,
  AgentSession,
} from "./contracts.js";
import type { ContextComposition } from "./context-composition.js";
import { normalizeIntentCategory } from "./session-classification.js";
import { stepExecutionDurationMs } from "./step-execution-time.js";

/**
 * Derived, incrementally maintained runtime statistics.
 *
 * The authoritative history stays in Rust. This projection is a small cache
 * persisted on the session record so widgets and the analytics page never have
 * to re-read every run/step/tool call just to show token totals.
 */
export const RUNTIME_ANALYTICS_VERSION = 3;
export const CONTEXT_USAGE_VERSION = 1;

export interface ContextUsageSnapshot {
  version: 1;
  /** Only provider-reported request usage is ever displayed. */
  source: "provider";
  stepId: string;
  /** Provider-reported inclusive input tokens for the answered request. */
  total: number;
  limit: number | null;
  /** Category split of `total`, taken from the local request estimate. */
  composition: ContextComposition;
  measuredAt: string;
}

export interface AnalyticsModelUsage {
  steps: number;
  input: number;
  output: number;
  total: number;
}

export interface AnalyticsUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Model requests observed, whether or not the provider reported usage. */
  requests: number;
  recorded: number;
  missing: number;
}

export interface SessionAnalytics {
  version: 3;
  /** Set while a v1 projection is waiting for its bounded legacy backfill. */
  requiresBackfill?: boolean;
  updatedAt: string;
  /** Terminal steps (the former "execution rounds" counter). */
  steps: number;
  completedRuns: number;
  completedRunSteps: number;
  toolCalls: number;
  toolCounts: Record<string, number>;
  usage: AnalyticsUsage;
  models: Record<string, AnalyticsModelUsage>;
  /**
   * Union of settled agent-step execution spans. Parked time (waiting for a
   * human, a permission reply or child sessions) and restart downtime are
   * excluded, and concurrent steps are counted once.
   */
  durationMs: number;
  userInputCount: number;
  /** Last counted message id makes projection updates idempotent across retries. */
  lastUserInputId: string | null;
  lastStepId: string | null;
  lastCompletedRunId: string | null;
  /**
   * Last 128 distinct terminal IDs, in first-observed order. Retained across
   * reloads to deduplicate out-of-order retries. Optional for older v2 data.
   */
  recentStepIds?: string[];
  recentCompletedRunIds?: string[];
}

export interface ProjectAnalyticsSession {
  id: string;
  parentSessionId: string | null;
  sessionGroup: string | null;
  title: string;
  status: AgentSession["status"];
  createdAt: string;
  completedAt: string | null;
  durationMs: number;
  userInputCount: number;
  updatedAt: string;
  model: string | null;
  context: {
    total: number;
    limit: number | null;
    percent: number | null;
    composition: ContextComposition;
    measuredAt: string;
  } | null;
  analytics: SessionAnalytics | null;
}

export interface ProjectAnalyticsGroup {
  sessionGroup: string | null;
  sessions: number;
  activeSessions: number;
  steps: number;
  completedRuns: number;
  toolCalls: number;
  userInputs: number;
  durationMs: number;
  tokens: { input: number; output: number; total: number };
}

export interface ProjectAnalytics {
  projectId: string;
  generatedAt: string;
  pendingBackfill: number;
  sessions: ProjectAnalyticsSession[];
  totals: {
    sessions: number;
    activeSessions: number;
    /** Sessions counted from an archived record that is still readable. */
    archivedSessions: number;
    /** Sessions counted from the retained ledger after a permanent delete. */
    deletedSessions: number;
    steps: number;
    completedRuns: number;
    toolCalls: number;
    userInputs: number;
    durationMs: number;
    tokens: { input: number; output: number; total: number };
    cache: {
      inputTokens: number;
      cacheReadTokens: number;
      ratio: number | null;
    };
    context: {
      totalTokens: number;
      windowTokens: number;
      percent: number | null;
      measuredSessions: number;
    };
    composition: {
      messages: number;
      tools: number;
      mcp: number;
      skills: number;
      system: number;
      total: number;
    };
  };
  models: Array<AnalyticsModelUsage & { model: string; sessions: number }>;
  tools: Array<{ toolId: string; calls: number }>;
  groups: ProjectAnalyticsGroup[];
}

const terminalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
/**
 * Statuses whose step is closed and may be folded into the projection. A step
 * parked on a permission reply records its end when it parks, so its execution
 * time and token usage must not wait for a resume that may never come.
 */
const settledStepStatuses = new Set([
  ...terminalStatuses,
  "waiting_permission",
  "blocked",
]);
const activeStatuses = new Set([
  "queued",
  "running",
  "waiting_permission",
  "waiting_input",
  "stopping",
]);
// This is a bounded retry window, not a history index. Retries older than the
// window need authoritative reconciliation; never retain every ID on a session.
const MAX_RECENT_DEDUPE_IDS = 128;

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
const count = (value: unknown): number => Math.trunc(number(value));
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function recentIds(value: unknown, fallback: string | null): string[] {
  // The legacy last ID is already counted, even when no window was persisted.
  const ids: string[] = fallback ? [fallback] : [];
  const seen = new Set(ids);
  const candidates = Array.isArray(value) ? value : [];
  for (let i = candidates.length - 1; i >= 0 && ids.length < MAX_RECENT_DEDUPE_IDS; i--) {
    const candidate = candidates[i];
    if (typeof candidate === "string" && candidate && !seen.has(candidate)) {
      seen.add(candidate);
      ids.push(candidate);
    }
  }
  return ids.reverse();
}

function rememberId(current: readonly string[], id: string): string[] {
  return [...current, id].slice(-MAX_RECENT_DEDUPE_IDS);
}

export function emptySessionAnalytics(): SessionAnalytics {
  return {
    version: RUNTIME_ANALYTICS_VERSION,
    updatedAt: new Date(0).toISOString(),
    steps: 0,
    completedRuns: 0,
    completedRunSteps: 0,
    toolCalls: 0,
    toolCounts: {},
    usage: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      requests: 0,
      recorded: 0,
      missing: 0,
    },
    models: {},
    durationMs: 0,
    userInputCount: 0,
    lastUserInputId: null,
    lastStepId: null,
    lastCompletedRunId: null,
  };
}

/**
 * Old v1 projections remain readable for list/status callers. The analytics
 * service separately recognizes them as incomplete and backfills them once.
 */
export function needsSessionAnalyticsBackfill(value: unknown): boolean {
  const raw = record(value);
  return (
    raw.version !== RUNTIME_ANALYTICS_VERSION ||
    raw.requiresBackfill === true ||
    typeof raw.durationMs !== "number" ||
    typeof raw.userInputCount !== "number"
  );
}

export function readSessionAnalytics(
  value: unknown,
): SessionAnalytics | null {
  const raw = record(value);
  // Older mirrors stay readable; the analytics service replaces them in the
  // background with a faithful recomputation.
  if (
    raw.version !== 1 &&
    raw.version !== 2 &&
    raw.version !== RUNTIME_ANALYTICS_VERSION
  )
    return null;
  const recentStepIds = Array.isArray(raw.recentStepIds)
    ? recentIds(
        raw.recentStepIds,
        typeof raw.lastStepId === "string" ? raw.lastStepId : null,
      )
    : undefined;
  const recentCompletedRunIds = Array.isArray(raw.recentCompletedRunIds)
    ? recentIds(
        raw.recentCompletedRunIds,
        typeof raw.lastCompletedRunId === "string"
          ? raw.lastCompletedRunId
          : null,
      )
    : undefined;
  const usage = record(raw.usage);
  const toolCounts = Object.fromEntries(
    Object.entries(record(raw.toolCounts))
      .map(([id, calls]) => [id, count(calls)] as const)
      .filter(([id, calls]) => id && calls > 0),
  );
  const models = Object.fromEntries(
    Object.entries(record(raw.models)).flatMap(([model, value]) => {
      const entry = record(value);
      const steps = count(entry.steps);
      const input = count(entry.input);
      const output = count(entry.output);
      const total = count(entry.total) || input + output;
      return model && (steps || total)
        ? [[model, { steps, input, output, total }] as const]
        : [];
    }),
  );
  return {
    version: RUNTIME_ANALYTICS_VERSION,
    ...(needsSessionAnalyticsBackfill(value) ? { requiresBackfill: true } : {}),
    ...(recentStepIds ? { recentStepIds } : {}),
    ...(recentCompletedRunIds ? { recentCompletedRunIds } : {}),
    updatedAt:
      typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
    steps: count(raw.steps),
    completedRuns: count(raw.completedRuns),
    completedRunSteps: count(raw.completedRunSteps),
    toolCalls: count(raw.toolCalls),
    toolCounts,
    usage: {
      input: count(usage.input),
      output: count(usage.output),
      reasoning: count(usage.reasoning),
      cacheRead: count(usage.cacheRead),
      cacheWrite: count(usage.cacheWrite),
      total: count(usage.total),
      requests: count(usage.requests),
      recorded: count(usage.recorded),
      missing: count(usage.missing),
    },
    models,
    durationMs: count(raw.durationMs),
    userInputCount: count(raw.userInputCount),
    lastUserInputId:
      typeof raw.lastUserInputId === "string" ? raw.lastUserInputId : null,
    lastStepId:
      typeof raw.lastStepId === "string" ? raw.lastStepId : null,
    lastCompletedRunId:
      typeof raw.lastCompletedRunId === "string"
        ? raw.lastCompletedRunId
        : null,
  };
}

export function isUserInputMessage(message: AgentRuntimeMessage): boolean {
  return message.role === "user" && message.metadata?.source !== "system_injection";
}

export function countUserInputs(messages: readonly AgentRuntimeMessage[]): number {
  return messages.reduce(
    (count, message) => count + (isUserInputMessage(message) ? 1 : 0),
    0,
  );
}

export function withUserInputAnalytics(
  current: SessionAnalytics | null,
  messageId: string,
  now = new Date().toISOString(),
): SessionAnalytics {
  const base = current ?? emptySessionAnalytics();
  if (!messageId || base.lastUserInputId === messageId) return base;
  return {
    ...base,
    version: RUNTIME_ANALYTICS_VERSION,
    updatedAt: now,
    userInputCount: base.userInputCount + 1,
    lastUserInputId: messageId,
  };
}

function sanitizeComposition(value: unknown): ContextComposition | null {
  const raw = record(value);
  const messages = count(raw.messages);
  const tools = count(raw.tools);
  const mcp = count(raw.mcp);
  const skills = count(raw.skills);
  const system = count(raw.system);
  const total = count(raw.total) || messages + tools + mcp + skills + system;
  if (total <= 0) return null;
  return {
    version: 2,
    messages,
    tools,
    mcp,
    skills,
    system,
    total,
    measuredAt:
      typeof raw.measuredAt === "string"
        ? raw.measuredAt
        : new Date().toISOString(),
  };
}

/**
 * The measured request context.
 *
 * `total` is exactly the provider's billed input for this request, so displayed
 * occupancy never drifts from the provider's own usage. The local composition
 * is not a second measurement: it only splits that total into categories,
 * rescaled so the parts keep summing to the measured total.
 */
export function measuredContextUsageSnapshot(
  composition: unknown,
  inputTokens: number,
  stepId: string,
  limit?: number | null,
  measuredAt = new Date().toISOString(),
): ContextUsageSnapshot | null {
  if (!stepId) return null;
  if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) return null;
  const source = sanitizeComposition(composition);
  const categories = ["messages", "tools", "mcp", "skills", "system"] as const;
  const split = {
    version: 2 as const,
    messages: 0,
    tools: 0,
    mcp: 0,
    skills: 0,
    system: 0,
    total: inputTokens,
    measuredAt,
  };
  if (source && source.total > 0) {
    let assigned = 0;
    for (const category of categories) {
      const value = Math.max(0, Math.trunc(number(source[category])));
      const scaled = Math.round((value / source.total) * inputTokens);
      split[category] = scaled;
      assigned += scaled;
    }
    // Rounded buckets must stay lossless; messages carries the correction.
    split.messages = Math.max(0, split.messages + inputTokens - assigned);
  } else {
    // No request estimate for this step: keep the measured total without
    // inventing a category split.
    split.messages = inputTokens;
  }
  return {
    version: CONTEXT_USAGE_VERSION,
    source: "provider",
    stepId,
    total: inputTokens,
    limit:
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? Math.trunc(limit)
        : null,
    composition: split,
    measuredAt,
  };
}

export function readContextUsage(
  value: unknown,
): ContextUsageSnapshot | null {
  const raw = record(value);
  if (raw.version !== CONTEXT_USAGE_VERSION) return null;
  // Older snapshots were local estimates; never present one as usage. A
  // snapshot that recorded its provider measurement is still usable.
  const measured = count(raw.measured);
  if (raw.source !== "provider" && measured <= 0) return null;
  const composition = sanitizeComposition(raw.composition);
  const total = count(raw.total) || composition?.total || 0;
  if (!composition || total <= 0) return null;
  const limit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit) && raw.limit > 0
      ? Math.trunc(raw.limit)
      : null;
  return {
    version: CONTEXT_USAGE_VERSION,
    source: "provider",
    stepId: typeof raw.stepId === "string" ? raw.stepId : "",
    total,
    limit,
    composition,
    measuredAt:
      typeof raw.measuredAt === "string"
        ? raw.measuredAt
        : composition.measuredAt,
  };
}

/**
 * Folds each terminal step once within the persisted recent-ID window. Later
 * metadata-only updates, even after another step, must not count it again.
 */
export function withStepAnalytics(
  current: SessionAnalytics | null,
  step: AgentRunStep,
  now = new Date().toISOString(),
): SessionAnalytics | null {
  if (!settledStepStatuses.has(step.status)) return current;
  const base = current ?? emptySessionAnalytics();
  const recentStepIds = recentIds(base.recentStepIds, base.lastStepId);
  if (!step.id || recentStepIds.includes(step.id)) return current;
  const metadata = record(step.metadata);
  const normalized = normalizeUsage(metadata.usage, {
    providerMetadata: metadata.providerMetadata,
    ...(metadata.backendId === "codex" ? { source: "cli" as const } : {}),
  });
  const input = normalized?.normalization.input;
  const known = input?.status === "known";
  const next: SessionAnalytics = {
    ...base,
    version: RUNTIME_ANALYTICS_VERSION,
    updatedAt: now,
    steps: base.steps + 1,
    usage: {
      ...base.usage,
      requests: base.usage.requests + 1,
      ...(known
        ? {
            recorded: base.usage.recorded + 1,
            input: base.usage.input + (input.value ?? 0),
            output:
              base.usage.output +
              (normalized?.normalization.output.value ?? 0),
            reasoning:
              base.usage.reasoning +
              (normalized?.normalization.reasoning.value ?? 0),
            cacheRead:
              base.usage.cacheRead +
              (normalized?.normalization.cacheRead.value ?? 0),
            cacheWrite:
              base.usage.cacheWrite +
              (normalized?.normalization.cacheWrite.value ?? 0),
          }
        : {
            missing: base.usage.missing + 1,
          }),
    },
    models: { ...base.models },
    durationMs: base.durationMs + stepExecutionDurationMs(step),
    lastStepId: step.id,
    recentStepIds: rememberId(recentStepIds, step.id),
  };
  if (known) {
    next.usage.total = next.usage.input + next.usage.output;
    const model = step.model?.trim() || "unknown";
    const previous = next.models[model] ?? {
      steps: 0,
      input: 0,
      output: 0,
      total: 0,
    };
    next.models[model] = {
      steps: previous.steps + 1,
      input: previous.input + (input.value ?? 0),
      output:
        previous.output + (normalized?.normalization.output.value ?? 0),
      total:
        previous.total +
        (input.value ?? 0) +
        (normalized?.normalization.output.value ?? 0),
    };
  }
  return next;
}

export function withCompletedRunAnalytics(
  current: SessionAnalytics | null,
  run: AgentRun,
  runStepCount: number,
  now = new Date().toISOString(),
): SessionAnalytics | null {
  if (run.status !== "completed") return current;
  const base = current ?? emptySessionAnalytics();
  const recentCompletedRunIds = recentIds(
    base.recentCompletedRunIds,
    base.lastCompletedRunId,
  );
  if (!run.id || recentCompletedRunIds.includes(run.id)) return current;
  return {
    ...base,
    version: RUNTIME_ANALYTICS_VERSION,
    updatedAt: now,
    completedRuns: base.completedRuns + 1,
    completedRunSteps: base.completedRunSteps + Math.max(0, count(runStepCount)),
    lastCompletedRunId: run.id,
    recentCompletedRunIds: rememberId(recentCompletedRunIds, run.id),
  };
}

export function withToolCallAnalytics(
  current: SessionAnalytics | null,
  toolId: string,
  now = new Date().toISOString(),
): SessionAnalytics {
  const base = current ?? emptySessionAnalytics();
  const id = toolId.trim() || "unknown";
  return {
    ...base,
    version: RUNTIME_ANALYTICS_VERSION,
    updatedAt: now,
    toolCalls: base.toolCalls + 1,
    toolCounts: {
      ...base.toolCounts,
      [id]: (base.toolCounts[id] ?? 0) + 1,
    },
  };
}

/** Maps the full authoritative stats response into the incremental shape. */
export function analyticsFromStats(stats: Record<string, unknown>): SessionAnalytics {
  const usage = record(record(stats.usage).self);
  const coverage = record(record(stats.coverage).self);
  const toolCounts = Object.fromEntries(
    Object.entries(record(stats.toolBreakdown))
      .map(([id, calls]) => [id, count(calls)] as const)
      .filter(([id, calls]) => id && calls > 0),
  );
  const models = Object.fromEntries(
    Object.entries(record(stats.modelBreakdown)).flatMap(([model, value]) => {
      const entry = record(value);
      const steps = count(entry.steps);
      const input = count(entry.input);
      const output = count(entry.output);
      const total = count(entry.total) || input + output;
      return model && (steps || total)
        ? [[model, { steps, input, output, total }] as const]
        : [];
    }),
  );
  return {
    version: RUNTIME_ANALYTICS_VERSION,
    updatedAt: new Date().toISOString(),
    steps: count(stats.roundCount),
    completedRuns: count(stats.completedRunCount),
    completedRunSteps: count(stats.completedRunSteps),
    toolCalls: count(stats.toolCallCount),
    toolCounts,
    usage: {
      input: count(usage.input),
      output: count(usage.output),
      reasoning: count(usage.reasoning),
      cacheRead: count(usage.cacheRead),
      cacheWrite: count(usage.cacheWrite),
      total: count(usage.total),
      requests: count(coverage.requests),
      recorded: count(coverage.recorded),
      missing: count(coverage.missing),
    },
    models,
    durationMs: count(stats.runningDuration),
    userInputCount: count(stats.userInputCount),
    lastUserInputId: null,
    lastStepId:
      typeof stats.lastStepId === "string" ? stats.lastStepId : null,
    lastCompletedRunId:
      typeof stats.lastCompletedRunId === "string"
        ? stats.lastCompletedRunId
        : null,
  };
}

export function compositionTotals(
  composition: ContextComposition | null,
): ProjectAnalytics["totals"]["composition"] {
  return {
    messages: count(composition?.messages),
    tools: count(composition?.tools),
    mcp: count(composition?.mcp),
    skills: count(composition?.skills),
    system: count(composition?.system),
    total: count(composition?.total),
  };
}

/**
 * The fields a statistics row needs. A permanently deleted session has no full
 * record left, so its row is built from the retained ledger entry instead.
 */
export type ProjectAnalyticsSessionInput = Pick<
  AgentSession,
  | "id"
  | "parentSessionId"
  | "status"
  | "createdAt"
  | "completedAt"
  | "updatedAt"
  | "sessionMetadata"
> & { title: string | null; prompt?: string };

/** A session counted in the totals but not listed as a live detail row. */
export interface ProjectAnalyticsRetainedSession {
  row: ProjectAnalyticsSession;
  retiredReason: "archived" | "deleted";
}

export function projectAnalyticsSession(
  session: ProjectAnalyticsSessionInput,
  analytics: SessionAnalytics | null,
  contextUsage: ContextUsageSnapshot | null,
): ProjectAnalyticsSession {
  const composition = contextUsage?.composition ?? null;
  const dominantModel = analytics
    ? Object.entries(analytics.models).sort(
        (a, b) => b[1].total - a[1].total,
      )[0]?.[0] ?? null
    : null;
  return {
    id: session.id,
    parentSessionId: session.parentSessionId,
    sessionGroup: normalizeIntentCategory(session.sessionMetadata?.intentCategory),
    title: session.title?.trim() || session.prompt?.slice(0, 120) || session.id,
    status: session.status,
    createdAt: session.createdAt,
    completedAt: session.completedAt,
    durationMs: analytics?.durationMs ?? 0,
    userInputCount: analytics?.userInputCount ?? 0,
    updatedAt: session.updatedAt,
    model: dominantModel,
    context: contextUsage
      ? {
          total: contextUsage.total,
          limit: contextUsage.limit,
          percent:
            contextUsage.limit && contextUsage.limit > 0
              ? Number(
                  Math.min(
                    100,
                    (contextUsage.total / contextUsage.limit) * 100,
                  ).toFixed(1),
                )
              : null,
          composition: composition!,
          measuredAt: contextUsage.measuredAt,
        }
      : null,
    analytics,
  };
}

export function buildProjectAnalytics(
  projectId: string,
  sessions: Array<{
    session: AgentSession;
    analytics: SessionAnalytics | null;
    contextUsage: ContextUsageSnapshot | null;
  }>,
  pendingBackfill: number,
  now = new Date().toISOString(),
  retained: readonly ProjectAnalyticsRetainedSession[] = [],
): ProjectAnalytics {
  const rows = sessions
    .map(({ session, analytics, contextUsage }) =>
      projectAnalyticsSession(session, analytics, contextUsage),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Archiving keeps the record and a permanent delete keeps only its ledger
  // entry, but either way the contribution it already made stays in the
  // totals; only live sessions keep a detail row.
  const counted = [...rows, ...retained.map((entry) => entry.row)];
  const totals = {
    sessions: counted.length,
    activeSessions: counted.filter((row) => activeStatuses.has(row.status))
      .length,
    archivedSessions: retained.filter(
      (entry) => entry.retiredReason === "archived",
    ).length,
    deletedSessions: retained.filter(
      (entry) => entry.retiredReason === "deleted",
    ).length,
    steps: 0,
    completedRuns: 0,
    toolCalls: 0,
    userInputs: 0,
    durationMs: 0,
    tokens: { input: 0, output: 0, total: 0 },
    cache: { inputTokens: 0, cacheReadTokens: 0, ratio: null as number | null },
    context: {
      totalTokens: 0,
      windowTokens: 0,
      percent: null as number | null,
      measuredSessions: 0,
    },
    composition: {
      messages: 0,
      tools: 0,
      mcp: 0,
      skills: 0,
      system: 0,
      total: 0,
    },
  };
  const models = new Map<
    string,
    AnalyticsModelUsage & { model: string; sessions: number }
  >();
  const tools = new Map<string, number>();
  const groups = new Map<string, ProjectAnalyticsGroup>();
  for (const row of counted) {
    const groupKey = row.sessionGroup ?? "";
    const group = groups.get(groupKey) ?? {
      sessionGroup: row.sessionGroup,
      sessions: 0,
      activeSessions: 0,
      steps: 0,
      completedRuns: 0,
      toolCalls: 0,
      userInputs: 0,
      durationMs: 0,
      tokens: { input: 0, output: 0, total: 0 },
    };
    group.sessions += 1;
    if (activeStatuses.has(row.status)) group.activeSessions += 1;
    group.userInputs += row.userInputCount;
    group.durationMs += row.durationMs;
    const analytics = row.analytics;
    if (analytics) {
      totals.steps += analytics.steps;
      totals.completedRuns += analytics.completedRuns;
      totals.toolCalls += analytics.toolCalls;
      totals.userInputs += analytics.userInputCount;
      totals.durationMs += analytics.durationMs;
      group.steps += analytics.steps;
      group.completedRuns += analytics.completedRuns;
      group.toolCalls += analytics.toolCalls;
      group.tokens.input += analytics.usage.input;
      group.tokens.output += analytics.usage.output;
      totals.tokens.input += analytics.usage.input;
      totals.tokens.output += analytics.usage.output;
      totals.cache.inputTokens += analytics.usage.input;
      totals.cache.cacheReadTokens += analytics.usage.cacheRead;
      for (const [model, usage] of Object.entries(analytics.models)) {
        const current = models.get(model) ?? {
          model,
          sessions: 0,
          steps: 0,
          input: 0,
          output: 0,
          total: 0,
        };
        current.sessions += 1;
        current.steps += usage.steps;
        current.input += usage.input;
        current.output += usage.output;
        current.total += usage.total;
        models.set(model, current);
      }
      for (const [toolId, calls] of Object.entries(analytics.toolCounts))
        tools.set(toolId, (tools.get(toolId) ?? 0) + calls);
    }
    group.tokens.total = group.tokens.input + group.tokens.output;
    groups.set(groupKey, group);
    if (row.context) {
      totals.context.totalTokens += row.context.total;
      totals.context.measuredSessions += 1;
      if (row.context.limit) totals.context.windowTokens += row.context.limit;
      const composition = compositionTotals(row.context.composition);
      totals.composition.messages += composition.messages;
      totals.composition.tools += composition.tools;
      totals.composition.mcp += composition.mcp;
      totals.composition.skills += composition.skills;
      totals.composition.system += composition.system;
      totals.composition.total += composition.total;
    }
  }
  totals.tokens.total = totals.tokens.input + totals.tokens.output;
  totals.cache.ratio =
    totals.cache.inputTokens > 0
      ? totals.cache.cacheReadTokens / totals.cache.inputTokens
      : null;
  totals.context.percent =
    totals.context.windowTokens > 0
      ? Number(
          Math.min(
            100,
            (totals.context.totalTokens / totals.context.windowTokens) * 100,
          ).toFixed(2),
        )
      : null;
  return {
    projectId,
    generatedAt: now,
    pendingBackfill,
    sessions: rows,
    totals,
    models: [...models.values()].sort((a, b) => b.total - a.total),
    tools: [...tools.entries()]
      .map(([toolId, calls]) => ({ toolId, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 24),
    groups: [...groups.values()].sort(
      (a, b) => b.sessions - a.sessions || b.durationMs - a.durationMs,
    ),
  };
}
