import type { AgentRun, AgentRunStep } from "./contracts.js";
import type { ContextMemorySnapshot } from "./context-memory.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { workStore, type WorkRecord } from "./work-store.js";
import { AgentValidationError } from "./runtime-errors.js";

/** Minimal read-only history view for request-local snapshot reuse. */
export interface ContextHistoryReader {
  listRuns(): AgentRun[];
  listRunSteps(runId: string): AgentRunStep[];
}

export interface ContextEpochDraft {
  version: 1;
  fromStepId: string | null;
  throughStepId: string;
  sourceFingerprint: string;
  memory: ContextMemorySnapshot;
  summary: string;
  preparedAt: string;
}
export interface ContextEpochState {
  version: 1;
  epoch: number;
  committedRequestCount: number;
  configurationFingerprint?: string;
  draft?: ContextEpochDraft;
}
export function readContextEpochState(value: unknown): ContextEpochState {
  const state = value as Partial<ContextEpochState> | undefined;
  if (
    !state ||
    state.version !== 1 ||
    !Number.isSafeInteger(state.epoch) ||
    state.epoch! < 0 ||
    !Number.isSafeInteger(state.committedRequestCount) ||
    state.committedRequestCount! < 0
  )
    return { version: 1, epoch: 0, committedRequestCount: 0 };
  return {
    ...state,
    version: 1,
    epoch: state.epoch!,
    committedRequestCount: state.committedRequestCount!,
  };
}

/** The furthest durable boundary applies across Works. Never reconstruct evicted steps. */
export function sessionContextBoundary(
  sessionId: string,
  history?: ContextHistoryReader,
): {
  steps: AgentRunStep[];
  boundary: number;
  summary: string | null;
  memory?: ContextMemorySnapshot;
  checkpointWork: WorkRecord | null;
} {
  // Legacy stores used REPLACE for metadata updates, so rowid is not a reliable clock.
  const runs = history ? history.listRuns() : store.listRuns(sessionId);
  const orderedRuns = runs.toSorted(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
  );
  const steps = orderedRuns.flatMap((run) =>
    history ? history.listRunSteps(run.id) : store.listRunSteps(run.id),
  );
  let boundary = -1;
  let summary: string | null = null;
  let checkpointWork: WorkRecord | null = null;
  const ids = new Set<string>();
  // One pass over the materialized runs; no second listRuns query.
  for (const run of runs)
    if (typeof run.metadata.workId === "string") ids.add(run.metadata.workId);
  for (const step of steps)
    if (typeof step.metadata.workId === "string") ids.add(step.metadata.workId);
  const current = workStore.current(sessionId);
  if (current) ids.add(current.id);
  const stepIndexById = new Map(
    steps.map((step, index) => [step.id, index] as const),
  );
  for (const id of ids) {
    const work = workStore.get(id);
    if (work?.sessionId !== sessionId || !work.checkpoint) continue;
    const index = stepIndexById.get(work.checkpoint.throughStepId) ?? -1;
    if (index < 0)
      throw new AgentValidationError(
        "context_blocked: the persisted context boundary is missing.",
      );
    if (index > boundary) {
      boundary = index;
      summary = work.checkpoint.summary;
      checkpointWork = work;
    }
  }
  const candidate = checkpointWork?.checkpoint?.memory;
  const memory =
    candidate?.version === 1 &&
    Array.isArray(candidate.entries) &&
    Array.isArray(candidate.sources) &&
    Array.isArray(candidate.omissionIndex)
      ? candidate
      : undefined;
  return { steps, boundary, summary, checkpointWork, memory };
}

export function sentContextRequests(
  steps: AgentRunStep[],
  currentStepId?: string,
): AgentRunStep[] {
  return steps.filter(
    (step) =>
      step.id !== currentStepId &&
      (step.metadata.runtimeReminder ||
        step.status === "completed" ||
        step.status === "failed"),
  );
}

/** Positive within-epoch changes only. Missing/legacy measurements never become zero samples. */
export function contextGrowthP95(
  steps: AgentRunStep[],
  epoch: number,
): number | undefined {
  const values: number[] = [];
  let previous: { tokens: number; model: string | null } | undefined;
  for (const step of steps.slice(-24)) {
    const diagnostic = step.metadata.contextCompaction as
      | { epoch?: number; compacted?: boolean; configurationChanged?: boolean }
      | undefined;
    const tokens = (
      step.metadata.contextComposition as { total?: number } | undefined
    )?.total;
    if (
      diagnostic?.epoch !== epoch ||
      diagnostic.compacted ||
      diagnostic.configurationChanged ||
      typeof tokens !== "number" ||
      !Number.isFinite(tokens)
    ) {
      previous = undefined;
      continue;
    }
    if (previous && previous.model === step.model && tokens > previous.tokens)
      values.push(tokens - previous.tokens);
    previous = { tokens, model: step.model };
  }
  return values.length >= 3
    ? values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
    : undefined;
}
