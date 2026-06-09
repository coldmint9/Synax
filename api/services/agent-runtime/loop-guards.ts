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

export function shouldForceFinalSummary(stepIndex: number, maxSteps: number): boolean {
  return stepIndex >= maxSteps;
}

const DEFAULT_FAILURE_REMINDER_THRESHOLD = 3;

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

