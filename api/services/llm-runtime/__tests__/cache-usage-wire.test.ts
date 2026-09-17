import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { applyUsageMiddleware } from '../middleware/usage.js';
import { cacheUsageSample } from '../../agent-runtime/cache-usage.js';

describe('Responses HTTP SSE to cache statistics', () => {
  it.each([0, 7424, undefined])('preserves wire cached_tokens=%s without inventing SDK zeros', async (cached) => {
    const usage = {
      input_tokens: 88169, output_tokens: 3, total_tokens: 88172,
      ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }),
      output_tokens_details: { reasoning_tokens: 0 },
    };
    const provider = createOpenAI({ apiKey: 'test-only', fetch: async () => new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_test', created_at: 1700000000, model: 'gpt-5.6-sol', status: 'completed',
        output: [], incomplete_details: null, usage,
      } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } },
    ) });
    const result = streamText({ model: applyUsageMiddleware(provider.responses('gpt-5.6-sol'), { protocol: 'openai-responses' }), prompt: 'fixture', maxRetries: 0 });
    await result.consumeStream();
    const sample = cacheUsageSample({ stepId: 'test', measuredAt: '', model: 'gpt-5.6-sol', unit: 'request' }, await result.usage, { source: 'sdk', providerMetadata: await result.providerMetadata });
    expect(sample.inputTokens).toBe(88169);
    expect(sample.cacheReadTokens).toBe(cached ?? null);
    expect(sample.ratio).toBe(cached === undefined ? null : cached / 88169);
    expect(sample.cacheSource).toBe(cached === undefined ? 'sdk:inputTokenDetails.cacheReadTokens' : 'raw:input_tokens_details.cached_tokens');
  });
});
