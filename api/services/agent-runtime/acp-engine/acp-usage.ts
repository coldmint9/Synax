import type { Usage, UsageUpdate } from '@agentclientprotocol/sdk';

/** Normalized usage stored on run step metadata (compatible with getSessionStats). */
export type StepUsageRecord = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  contextWindowSize?: number;
  source?: 'acp';
};

export function asStepUsageRecord(value: unknown): StepUsageRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as StepUsageRecord;
}

export function usageFromAcpPrompt(usage: Usage): StepUsageRecord {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    thoughtTokens: usage.thoughtTokens ?? undefined,
    cachedReadTokens: usage.cachedReadTokens ?? undefined,
    cachedWriteTokens: usage.cachedWriteTokens ?? undefined,
    source: 'acp',
  };
}

export function usageFromAcpUpdate(update: UsageUpdate): StepUsageRecord {
  return {
    inputTokens: update.used,
    contextWindowSize: update.size,
    source: 'acp',
  };
}

export function mergeStepUsage(
  current: StepUsageRecord | undefined,
  patch: StepUsageRecord,
): StepUsageRecord {
  const next: StepUsageRecord = { ...current, ...patch, source: 'acp' };
  for (const key of Object.keys(next) as Array<keyof StepUsageRecord>) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}

export function readUsageInputTokens(usage: Record<string, unknown>): number {
  const input = usage.inputTokens ?? usage.used ?? usage.promptTokens ?? usage.input_tokens;
  return typeof input === 'number' && input > 0 ? input : 0;
}

export function readUsageOutputTokens(usage: Record<string, unknown>): number {
  const output = usage.outputTokens ?? usage.completionTokens ?? usage.output_tokens;
  return typeof output === 'number' && output > 0 ? output : 0;
}

export function readUsageContextWindowSize(usage: Record<string, unknown>): number | undefined {
  const size = usage.contextWindowSize ?? usage.contextLimit ?? usage.size;
  return typeof size === 'number' && size > 0 ? size : undefined;
}
