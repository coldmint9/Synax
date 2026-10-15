import type { ToolCallRecord } from './contracts.js';

const DOOM_LOOP_THRESHOLD = 3;

export function normalizeToolArgsHash(toolCall: Pick<ToolCallRecord, 'toolId' | 'argsHash'>): string {
  return `${toolCall.toolId}:${toolCall.argsHash}`;
}

function stepSignature(calls: ToolCallRecord[]): string {
  // Exclude deduped (compacted with null outputRef) calls — they don't represent
  // real work and would falsely trigger doom loop detection when the LLM
  // legitimately needs to re-read cleared data.
  const real = calls.filter(c => !(c.status === 'compacted' && c.outputRef === null));
  if (real.length === 0) return `__dedup_only_${calls.length}__${Math.random()}`;
  return real.map(normalizeToolArgsHash).sort().join('|');
}

/**
 * Identity of a step's executed calls, independent of the order in which the
 * store happens to return them. A step that repeats an unchanged call set has
 * the same signature. Steps with neither executed calls nor a recorded
 * assistant message are runtime noise (interrupted or empty steps) and return
 * null so they cannot break an otherwise identical run of steps.
 */
function repeatedStepKey(step: {
  calls: ToolCallRecord[];
  content?: string | null;
  toolCallCount?: number;
}): string | null {
  if (step.content !== null && step.content !== undefined && step.content.trim() !== '')
    return `text:${step.content}`;
  if (step.calls.length === 0) return step.toolCallCount ? 'calls:unknown' : null;
  return stepSignature(step.calls);
}

/**
 * A step that did nothing at all: no call, no assistant text, no requested call.
 * An empty round is honest output, so repeating it must not loop forever.
 */
function isEmptyStep(step: {
  calls: ToolCallRecord[];
  content?: string | null;
  toolCallCount?: number;
}): boolean {
  return (
    step.calls.length === 0 &&
    !step.toolCallCount &&
    !step.content?.trim()
  );
}

export function detectDoomLoop(toolCalls: ToolCallRecord[], threshold = DOOM_LOOP_THRESHOLD): ToolCallRecord | null {
  const stepMap = new Map<string, ToolCallRecord[]>();
  for (const tc of toolCalls) {
    const key = tc.stepId ?? tc.id;
    const group = stepMap.get(key);
    if (group) group.push(tc);
    else stepMap.set(key, [tc]);
  }
  const steps = [...stepMap.values()];
  if (steps.length < threshold) return null;
  const recent = steps.slice(-threshold);
  const sigs = recent.map(stepSignature);
  const first = sigs[0];
  if (sigs.every((s) => s === first)) {
    const lastStep = recent[recent.length - 1] ?? [];
    return lastStep[lastStep.length - 1] ?? null;
  }
  return null;
}

/** What a repeated-call guard found: the summary to report and the call to cite. */
export interface RepeatedCallLoop {
  toolId: string;
  toolCallId: string;
  repeats: number;
}

/**
 * Last-resort anti-loop guard on the real step sequence of a run.
 *
 * `detectDoomLoop` above only sees tool calls grouped by step, so it misses a
 * run that repeats a call with a CHANGING argument (for example `task_list`
 * whose stored result grows, or a selector that keeps resolving differently):
 * every step then carries a distinct args hash and never matches. This guard
 * instead compares normalized, mutation-free step signatures, ignoring
 * timestamp-like noise, so an unchanged cycle is caught even when its argument
 * values differ.
 *
 * It also catches a step that repeats with no calls and no assistant text at
 * all, which would otherwise spin the round forever.
 *
 * Returns null while the trailing sequence still makes progress. `mutationFree`
 * is false for steps that used a write/state-changing tool: those change the
 * workspace, so identical repeats without new information only after
 * `staleMutationRepeatThreshold` repeats.
 */
export function detectRepeatedCallLoop(input: {
  steps: Array<{
    id?: string | null;
    calls: ToolCallRecord[];
    content?: string | null;
    toolCallCount?: number;
  }>;
  /** Steps to report and cite; defaults to the whole run. */
  threshold?: number;
  mutationFree?: boolean;
  staleMutationRepeatThreshold?: number;
}): RepeatedCallLoop | null {
  const {
    steps,
    threshold: optionThreshold,
    mutationFree = true,
    staleMutationRepeatThreshold = DEFAULT_STALE_MUTATION_REMINDER_THRESHOLD,
  } = input;
  const threshold = optionThreshold ?? (mutationFree ? 2 : staleMutationRepeatThreshold);
  if (steps.length < threshold) return null;

  const recent = steps.slice(-threshold);
  const last = recent[recent.length - 1];
  const lastKey = repeatedStepKey(last);
  if (lastKey === null) return null;

  // Keep walking back while the cycle repeats; the streak is reported so the
  // corrective note states how many times the same step came back.
  let repeats = 1;
  for (let i = steps.length - 2; i >= 0; i--) {
    if (repeatedStepKey(steps[i]) !== lastKey) break;
    repeats++;
  }
  if (repeats < threshold) return null;

  const call = last.calls[last.calls.length - 1];
  if (call) return { toolId: call.toolId, toolCallId: call.id, repeats };
  if (isEmptyStep(last)) {
    const earlier = [...steps].reverse().find((step) => step.calls.length > 0)?.calls ?? [];
    const previous = earlier[earlier.length - 1];
    return {
      toolId: previous?.toolId ?? 'runtime.final',
      toolCallId: previous?.id ?? last.id ?? '',
      repeats,
    };
  }
  return null;
}

export function shouldConverge(stepIndex: number, stepThreshold: number): boolean {
  return stepIndex >= stepThreshold;
}

const DEFAULT_FAILURE_REMINDER_THRESHOLD = 3;
/** A run serves at most this many steps before it is stopped at the tool gate. */
export const RUN_STEP_HARD_LIMIT = 60;
/** Stale repeats of a non-mutating call before the run is stopped at the tool gate. */
export const STALE_INCREMENTAL_REMINDER_THRESHOLD = 30;
const STALE_INCREMENTAL_STOP_THRESHOLD = 40;
/** Stale repeats of a call that changes the workspace: report, then stop much later. */
export const DEFAULT_STALE_MUTATION_REMINDER_THRESHOLD = 12;
const MUTATION_STOP_THRESHOLD = 30;

/** At this many tool calls a run is stopped so a hard loop cannot continue forever. */
export const RUN_TOOL_CALL_HARD_LIMIT = 60;

/**
 * How persistent a repeated cycle must be before it is treated as a genuine
 * loop. A stale repeat is still a nudge while the cycle is short, but a run
 * that keeps repeating one call hundreds of times is a hard loop regardless of
 * whether its argument keeps changing.
 */
export function stalenessStopThreshold(input: {
  repeats: number;
  mutationFree: boolean;
}): number {
  if (!input.mutationFree) return MUTATION_STOP_THRESHOLD;
  return input.repeats >= RUN_STEP_HARD_LIMIT
    ? RUN_STEP_HARD_LIMIT
    : STALE_INCREMENTAL_STOP_THRESHOLD;
}

/**
 * Detect a trailing streak of consecutive failures of the SAME tool and return a
 * corrective reminder for the model. This REPLACES the old "block the session
 * after N failures" behavior: a failed tool call is a signal the model should
 * act on, not a reason to terminate the session. Genuine no-progress loops
 * (identical call repeated) are still caught separately by detectDoomLoop.
 *
 * Counts only the trailing run of `status === 'failed'` calls for one tool id;
 * any success, or a different tool, resets the streak. Returns null below
 * threshold. Deduped placeholder calls are ignored.
 */
export function buildConsecutiveFailureReminder(
  toolCalls: ToolCallRecord[],
  threshold = DEFAULT_FAILURE_REMINDER_THRESHOLD,
): string | null {
  const real = toolCalls.filter(c => !(c.status === 'compacted' && c.outputRef === null));
  if (real.length === 0) return null;

  const last = real[real.length - 1];
  if (last.status !== 'failed') return null;

  let streak = 0;
  let lastError = '';
  for (let i = real.length - 1; i >= 0; i--) {
    const call = real[i];
    if (call.status === 'failed' && call.toolId === last.toolId) {
      streak++;
      if (!lastError && call.error) lastError = call.error;
    } else {
      break;
    }
  }

  if (streak < threshold) return null;

  const errorHint = lastError ? ` Most recent error: ${lastError.slice(0, 300)}` : '';
  return `\`${last.toolId}\` has failed ${streak} times in a row.${errorHint} Stop repeating the same attempt — change your approach, fix the arguments, or use a different tool to make progress.`;
}
