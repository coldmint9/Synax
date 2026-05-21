import type { ToolCallRecord } from './contracts.js';

const DOOM_LOOP_THRESHOLD = 3;

export function normalizeToolArgsHash(toolCall: Pick<ToolCallRecord, 'toolId' | 'argsHash'>): string {
  return `${toolCall.toolId}:${toolCall.argsHash}`;
}

function stepSignature(calls: ToolCallRecord[]): string {
  return calls.map(normalizeToolArgsHash).sort().join('|');
}

export function detectDoomLoop(toolCalls: ToolCallRecord[]): ToolCallRecord | null {
  // Group tool calls by stepId so parallel calls within one step count as one unit.
  const stepMap = new Map<string, ToolCallRecord[]>();
  for (const tc of toolCalls) {
    const key = tc.stepId ?? tc.id;
    const group = stepMap.get(key);
    if (group) group.push(tc);
    else stepMap.set(key, [tc]);
  }
  const steps = [...stepMap.values()];
  if (steps.length < DOOM_LOOP_THRESHOLD) return null;
  const recent = steps.slice(-DOOM_LOOP_THRESHOLD);
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
