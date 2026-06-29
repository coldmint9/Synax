import { describe, expect, it } from 'vitest';
import {
  mergeStepUsage,
  readUsageContextWindowSize,
  readUsageInputTokens,
  readUsageOutputTokens,
  usageFromAcpPrompt,
  usageFromAcpUpdate,
} from '../acp-usage.js';

describe('acp usage helpers', () => {
  it('maps prompt usage into step metadata fields', () => {
    expect(usageFromAcpPrompt({
      inputTokens: 12_000,
      outputTokens: 800,
      totalTokens: 12_800,
      thoughtTokens: 200,
    })).toEqual({
      inputTokens: 12_000,
      outputTokens: 800,
      totalTokens: 12_800,
      thoughtTokens: 200,
      source: 'acp',
    });
  });

  it('maps usage_update into context occupancy fields', () => {
    expect(usageFromAcpUpdate({ used: 42_000, size: 200_000 })).toEqual({
      inputTokens: 42_000,
      contextWindowSize: 200_000,
      source: 'acp',
    });
  });

  it('merges usage patches without dropping prior fields', () => {
    expect(mergeStepUsage(
      { inputTokens: 40_000, contextWindowSize: 200_000, source: 'acp' },
      { outputTokens: 900, totalTokens: 40_900 },
    )).toEqual({
      inputTokens: 40_000,
      contextWindowSize: 200_000,
      outputTokens: 900,
      totalTokens: 40_900,
      source: 'acp',
    });
  });

  it('reads usage fields for session stats aggregation', () => {
    const usage = {
      inputTokens: 10_000,
      outputTokens: 500,
      contextWindowSize: 128_000,
    };
    expect(readUsageInputTokens(usage)).toBe(10_000);
    expect(readUsageOutputTokens(usage)).toBe(500);
    expect(readUsageContextWindowSize(usage)).toBe(128_000);
    expect(readUsageInputTokens({ used: 55_000 })).toBe(55_000);
  });
});
