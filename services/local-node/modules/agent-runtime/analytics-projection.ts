import { normalizeUsage } from "../../infrastructure/llm-runtime/usage.js";
import type {
  AgentRun,
  AgentRunStep,
  AgentSession,
} from "./contracts.js";
import type { ContextComposition } from "./context-composition.js";

/**
 * Derived, incrementally maintained runtime statistics.
 *
 * The authoritative history stays in Rust. This projection is a small cache
 * persisted on the session record so widgets and the analytics page never have
 * to re-read every run/step/tool call just to show token totals.
 */
export const RUNTIME_ANALYTICS_VERSION = 1;
export const CONTEXT_USAGE_VERSION = 1;

export interface ContextUsageSnapshot {
  version: 1;
  stepId: string;
  /** Locally measured request context, including every classified category. */
  total: number;
  limit: number | null;
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
  version: 1;
  updatedAt: string;
  /** Terminal steps (the former "execution rounds" counter). */
  steps: number;
  completedRuns: number;
  completedRunSteps: number;
  toolCalls: number;
  toolCounts: Record<string, number>;
  usage: AnalyticsUsage;
  models: Record<string, AnalyticsModelUsage>;
  lastStepId: string | null;
  lastCompletedRunId: string | null;
}

export interface ProjectAnalyticsSession {
  id: string;
  parentSessionId: string | null;
  title: string;
  status: AgentSession["status"];
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

export interface ProjectAnalytics {
  projectId: string;
  generatedAt: string;
  pendingBackfill: number;
  sessions: ProjectAnalyticsSession[];
  totals: {
    sessions: number;
    activeSessions: number;
    steps: number;
    completedRuns: number;
    toolCalls: number;
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
}

const terminalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const activeStatuses = new Set([
  "queued",
  "running",
  "waiting_permission",
  "waiting_input",
  "stopping",
]);

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
const count = (value: unknown): number => Math.trunc(number(value));
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

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
    lastStepId: null,
    lastCompletedRunId: null,
  };
}

export function readSessionAnalytics(
  value: unknown,
): SessionAnalytics | null {
  const raw = record(value);
  if (raw.version !== RUNTIME_ANALYTICS_VERSION) return null;
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
    lastStepId:
      typeof raw.lastStepId === "string" ? raw.lastStepId : null,
    lastCompletedRunId:
      typeof raw.lastCompletedRunId === "string"
        ? raw.lastCompletedRunId
        : null,
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

export function contextUsageSnapshot(
  composition: unknown,
  stepId: string,
  limit?: number | null,
): ContextUsageSnapshot | null {
  const sanitized = sanitizeComposition(composition);
  if (!sanitized || !stepId) return null;
  return {
    version: CONTEXT_USAGE_VERSION,
    stepId,
    total: sanitized.total,
    limit:
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? Math.trunc(limit)
        : null,
    composition: sanitized,
    measuredAt: sanitized.measuredAt,
  };
}

export function readContextUsage(
  value: unknown,
): ContextUsageSnapshot | null {
  const raw = record(value);
  if (raw.version !== CONTEXT_USAGE_VERSION) return null;
  const composition = sanitizeComposition(raw.composition);
  const total = count(raw.total) || composition?.total || 0;
  if (!composition || total <= 0) return null;
  const limit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit) && raw.limit > 0
      ? Math.trunc(raw.limit)
      : null;
  return {
    version: CONTEXT_USAGE_VERSION,
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
 * Folds one terminal step into the aggregate. `lastStepId` makes repeated
 * updates of the same step (thought/tool metadata) idempotent.
 */
export function withStepAnalytics(
  current: SessionAnalytics | null,
  step: AgentRunStep,
  now = new Date().toISOString(),
): SessionAnalytics | null {
  if (!terminalStatuses.has(step.status)) return current;
  const base = current ?? emptySessionAnalytics();
  if (base.lastStepId === step.id) return current;
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
    lastStepId: step.id,
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
  if (base.lastCompletedRunId === run.id) return current;
  return {
    ...base,
    version: RUNTIME_ANALYTICS_VERSION,
    updatedAt: now,
    completedRuns: base.completedRuns + 1,
    completedRunSteps: base.completedRunSteps + Math.max(0, count(runStepCount)),
    lastCompletedRunId: run.id,
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

export function projectAnalyticsSession(
  session: AgentSession,
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
    title: session.title?.trim() || session.prompt.slice(0, 120) || session.id,
    status: session.status,
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
): ProjectAnalytics {
  const rows = sessions
    .map(({ session, analytics, contextUsage }) =>
      projectAnalyticsSession(session, analytics, contextUsage),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const totals = {
    sessions: rows.length,
    activeSessions: rows.filter((row) => activeStatuses.has(row.status)).length,
    steps: 0,
    completedRuns: 0,
    toolCalls: 0,
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
  for (const row of rows) {
    const analytics = row.analytics;
    if (analytics) {
      totals.steps += analytics.steps;
      totals.completedRuns += analytics.completedRuns;
      totals.toolCalls += analytics.toolCalls;
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
  };
}
