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
