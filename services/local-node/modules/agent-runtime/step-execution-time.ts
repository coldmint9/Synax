import type { AgentRunStep } from "./contracts.js";

/**
 * Execution time for a step, a session and a project total.
 *
 * A step's wall-clock span is not its execution time. The step stays open while
 * a form waits for the user, while a permission reply is pending and while
 * child sessions run; a forced termination (app quit, runtime restart) stamps
 * `completedAt` at recovery time, which adds the whole downtime. Summing raw
 * spans therefore counts idle time, restart gaps and the same concurrent work
 * twice.
 *
 * The runtime therefore measures *active* spans:
 * - open steps (`completedAt` missing) contribute nothing yet,
 * - parked time is removed (`analyticsParkedMs` recorded by the store, plus
 *   wait intervals reconstructed from interactions and permissions),
 * - forced terminations end at the last recorded activity,
 * - overlapping spans are merged, so concurrency is counted once.
 */

export interface TimeSpan {
  start: number;
  end: number;
}

/** Finish reasons stamped after the runtime stopped producing output. */
const FORCED_STOP_FINISH_REASONS = new Set([
  "runtime_restart",
  "execution_stopped",
  "history_restored",
]);

export function isParkedStep(step: Pick<AgentRunStep, "status" | "metadata"> | null | undefined): boolean {
  if (!step) return false;
  if (isAwaitingUser(step)) return true;
  return step.metadata?.awaitingSubagents === true;
}

/**
 * A step that is waiting for the user: a form answer or a permission reply.
 *
 * Waiting on child sessions is not this: the agent is not idle then, it is
 * supervising work it started.
 */
export function isAwaitingUser(step: Pick<AgentRunStep, "status"> | null | undefined): boolean {
  if (!step) return false;
  return step.status === "waiting_input" || step.status === "waiting_permission";
}

const toMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const nonNegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Union of the given spans; empty and inverted spans are dropped. */
export function mergeTimeSpans(spans: readonly TimeSpan[]): TimeSpan[] {
  const sorted = spans
    .filter(
      (span) =>
        Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start,
    )
    .sort((a, b) => a.start - b.start);
  const merged: TimeSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  return merged;
}

/** Covered milliseconds; concurrent spans are counted once. */
export function coveredDurationMs(spans: readonly TimeSpan[]): number {
  return mergeTimeSpans(spans).reduce((sum, span) => sum + (span.end - span.start), 0);
}

/** Removes the parts of `base` covered by `holes`. */
export function subtractTimeSpans(
  base: readonly TimeSpan[],
  holes: readonly TimeSpan[],
): TimeSpan[] {
  const mergedHoles = mergeTimeSpans(holes);
  if (mergedHoles.length === 0) return mergeTimeSpans(base);
  const result: TimeSpan[] = [];
  for (const span of mergeTimeSpans(base)) {
    let cursor = span.start;
    for (const hole of mergedHoles) {
      if (hole.end <= cursor) continue;
      if (hole.start >= span.end) break;
      if (hole.start > cursor) result.push({ start: cursor, end: Math.min(hole.start, span.end) });
      cursor = Math.max(cursor, hole.end);
      if (cursor >= span.end) break;
    }
    if (cursor < span.end) result.push({ start: cursor, end: span.end });
  }
  return result;
}

export interface StepTimingContext {
  /**
   * Wait intervals reconstructed from persisted records. Used for sessions
   * whose steps were written before the store recorded park accounting.
   */
  waitSpans?: readonly TimeSpan[];
  /** Last activity recorded for the step, when the caller can reconstruct it. */
  lastActivityMs?: number | null;
}

/**
 * Spans in which the step actually ran.
 *
 * A step that never reached `completedAt` is still open (or was abandoned):
 * counting it would let the total grow on every read, so it contributes
 * nothing until it settles.
 */
export function stepExecutionSpans(
  step: Pick<AgentRunStep, "status" | "startedAt" | "completedAt" | "finishReason" | "metadata">,
  context: StepTimingContext = {},
): TimeSpan[] {
  const start = toMs(step.startedAt);
  const completed = toMs(step.completedAt);
  if (start === null || completed === null || completed <= start) return [];
  let end = completed;
  const lastActivity =
    typeof context.lastActivityMs === "number" && Number.isFinite(context.lastActivityMs)
      ? context.lastActivityMs
      : toMs(step.metadata?.analyticsLastActiveAt);
  // A forced termination stamps `completedAt` at recovery, long after the step
  // stopped. Only a wait recorded by the store may still sit inside the span.
  if (
    (FORCED_STOP_FINISH_REASONS.has(step.finishReason ?? "") ||
      step.status === "interrupted") &&
    lastActivity !== null &&
    lastActivity > start &&
    lastActivity < end
  ) {
    end = lastActivity;
  }
  const span = { start, end };
  const parkedMs = nonNegative(step.metadata?.analyticsParkedMs);
  const holes: TimeSpan[] = [...(context.waitSpans ?? [])];
  // Microseconds-level position of a recorded park is irrelevant inside a
  // single step, so it is subtracted from the step's tail.
  if (parkedMs > 0) holes.push({ start: Math.max(start, end - parkedMs), end });
  return subtractTimeSpans([span], holes);
}

/** Execution time of one step; overlapping waits are not counted. */
export function stepExecutionDurationMs(
  step: Parameters<typeof stepExecutionSpans>[0],
  context: StepTimingContext = {},
): number {
  return coveredDurationMs(stepExecutionSpans(step, context));
}

/**
 * Execution time of a session.
 *
 * Steps of one session never run in parallel by design; merging keeps a
 * mis-recorded or legacy overlap from being counted twice.
 */
export function sessionExecutionDurationMs(
  steps: readonly Parameters<typeof stepExecutionSpans>[0][],
  timingFor?: (step: Parameters<typeof stepExecutionSpans>[0]) => StepTimingContext,
): number {
  return coveredDurationMs(
    steps.flatMap((step) => stepExecutionSpans(step, timingFor?.(step) ?? {})),
  );
}

/** Builds a wait interval from a record that is still open. */
export function openSpan(startedAt: unknown, endedAt: unknown, now = Date.now()): TimeSpan | null {
  const start = toMs(startedAt);
  if (start === null) return null;
  const end = toMs(endedAt) ?? now;
  return end > start ? { start, end } : null;
}

export interface WaitWindow {
  /** Wait already accumulated on the step, in milliseconds. */
  ms: number;
  /** ISO start of the window that is still open, or null when the step is idle. */
  since: string | null;
}

/**
 * Continues one wait counter across a rewrite of its step.
 *
 * A wait is only observable while the runtime runs, so the counter is closed by
 * the write that resumes the step. A repeated write while the step still waits
 * must not restart the window, and an idle step must not accrue anything.
 */
export function accumulateWaitWindow(
  prior: WaitWindow,
  waiting: boolean,
  now: number,
): WaitWindow {
  const ms = nonNegative(prior.ms);
  const since = toMs(prior.since);
  if (!waiting) {
    return since === null
      ? { ms, since: null }
      : { ms: ms + Math.max(0, now - since), since: null };
  }
  return { ms, since: since === null ? new Date(now).toISOString() : prior.since };
}
