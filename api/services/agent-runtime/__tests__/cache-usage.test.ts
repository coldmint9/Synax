import { normalizeUsage } from '../../llm-runtime/usage.js';
import { describe, expect, it } from 'vitest';
import { cacheUsageSample, projectCacheUsage } from '../cache-usage.js';
const sample = (input: number, cached: number, stepId = 's') => cacheUsageSample({
  stepId, measuredAt: '', model: 'test', unit: 'request',
}, { raw: { input_tokens: input, input_tokens_details: { cached_tokens: cached } } }, { protocol: 'openai-responses' });

describe('auditable provider cache measurements', () => {
  it('reproduces the screenshot ratio from reported token totals', () => {
    const result = projectCacheUsage([sample(4_274_113, 811_648, 'earlier'), sample(88_169, 0)]);
    expect(result.latest?.ratio).toBe(0);
    expect((result.session.weightedRatio! * 100).toFixed(1)).toBe('18.6');
    expect(result.session.inputTokens).toBe(4_362_282);
    expect(result.session.cacheReadTokens).toBe(811_648);
  });
  it('uses the last ten records including unknowns and zeros, not the last ten hits', () => {
    const rows = Array.from({ length: 12 }, (_, index) => sample(100, index < 2 ? 100 : 0, String(index)));
    const missing = cacheUsageSample({ stepId: 'missing', measuredAt: '', model: null, unit: 'request' }, {}, {});
    const result = projectCacheUsage([...rows, missing], 1);
    expect(result.recent).toMatchObject({ samples: 10, matched: 9, missing: 1, ratio: 0 });
    expect(result.latest?.ratio).toBeNull();
    expect(result.pending).toBe(1);
    expect(result.recentSamples[0].stepId).toBe('missing');
  });
  it('takes original API fields over conflicting persisted normalized metrics', () => {
    const raw = { input_tokens: 100, input_tokens_details: { cached_tokens: 80 } };
    const result = cacheUsageSample({ stepId: 's', measuredAt: '', model: null, unit: 'request' }, {
      ...normalizeUsage({ inputTokens: 1000, cachedInputTokens: 10 }), raw,
    }, { protocol: 'openai-responses' });
    expect(result).toMatchObject({ inputTokens: 100, cacheReadTokens: 80, ratio: 0.8, cacheSource: 'raw:input_tokens_details.cached_tokens' });
  });
  it('averages request percentages equally, including true zero hits', () => {
    const result = projectCacheUsage([sample(100, 80, 'small'), sample(1000, 0, 'large')]);
    expect(result.session.ratio).toBe(0.4);
    expect(result.session.weightedRatio).toBe(80 / 1100);
  });
  it('does not mistake aggregate external turns for individual requests', () => {
    const result = projectCacheUsage([{ ...sample(100, 80), unit: 'external-turn' }]);
    expect(result.session).toMatchObject({ aggregated: 1, matched: 0, ratio: null });
  });
  it('includes Anthropic cache writes only in the denominator', () => {
    const result = cacheUsageSample({ stepId: 's', measuredAt: '', model: null, unit: 'request' }, { raw: {
      input_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 300,
    } }, { protocol: 'anthropic' });
    expect(result.ratio).toBe(0.6);
  });
  it('does not fabricate rates for missing, invalid or empty measurements', () => {
    const result = projectCacheUsage([sample(100, 200), sample(0, 0)]);
    expect(result.session).toMatchObject({ invalid: 1, matched: 0, empty: 1, ratio: null });
    expect(projectCacheUsage([]).latest).toBeNull();
  });
});
