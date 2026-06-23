import { Hono } from 'hono';
import * as z from 'zod/v4';
import { logger } from '../lib/logger.js';
import { formatCorpusStats, loadRepositoryCorpus } from '../prototypes/tree-embedding-bench/corpus-loader.js';
import {
  formatBenchmarkReport,
  listSerializationStrategies,
  runTreeEmbeddingBenchmark,
  serializeChunkContext,
} from '../prototypes/tree-embedding-bench/index.js';

export const treeEmbeddingBenchRoutes = new Hono();

treeEmbeddingBenchRoutes.get('/health', async (c) => {
  const { EmbeddingClient } = await import('../prototypes/tree-embedding-bench/embedding-client.js');
  const client = new EmbeddingClient();
  const ok = await client.health();
  return c.json({ ok, baseUrl: client.baseUrl }, ok ? 200 : 503);
});

treeEmbeddingBenchRoutes.get('/strategies', (c) => {
  return c.json({ strategies: listSerializationStrategies() });
});

treeEmbeddingBenchRoutes.get('/corpus', async (c) => {
  const maxChunks = Number(c.req.query('limit') ?? '0') || undefined;
  const corpus = await loadRepositoryCorpus({ maxChunks });
  return c.json({
    repoRoot: corpus.repoRoot,
    stats: corpus.codeIndex.stats,
    indexedChunks: corpus.chunkContexts.length,
    summary: formatCorpusStats(corpus),
    sample: corpus.chunkContexts.slice(0, 5).map((ctx) => ({
      chunkId: ctx.chunk.id,
      path: ctx.file.path,
      lines: ctx.chunk.range,
      symbols: ctx.symbols.map((s) => s.name),
      preview: serializeChunkContext(ctx, 'chunk-source').slice(0, 400),
    })),
  });
});

const strategyEnum = z.enum([
  'chunk-source',
  'chunk-enriched',
  'signature',
  'symbol-card',
  'skeleton',
  'graph-context',
]);

const runSchema = z.object({
  baseUrl: z.string().url().optional(),
  repoRoot: z.string().optional(),
  maxChunks: z.number().int().positive().optional(),
  strategies: z.array(strategyEnum).optional(),
});

treeEmbeddingBenchRoutes.post('/run', async (c) => {
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  try {
    const report = await runTreeEmbeddingBenchmark(parsed.data);
    return c.json({
      ok: true,
      report,
      summary: formatBenchmarkReport(report),
    });
  } catch (err) {
    logger.warn({ err }, 'tree-embedding-bench run failed');
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : 'benchmark failed' },
      503,
    );
  }
});
