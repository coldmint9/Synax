import { describe, expect, it } from 'vitest';

import { extractEmbedding } from '../embedding-client.js';
import { defaultRetrievalTasks, loadFixtureIndex } from '../fixtures.js';
import { listSerializationStrategies } from '../serializers.js';

describe('tree-embedding-bench fixtures', () => {
  it('解析样本文件并生成 symbol contexts', async () => {
    const fixture = await loadFixtureIndex();
    expect(fixture.codeIndex.stats.fileCount).toBeGreaterThanOrEqual(3);
    expect(fixture.codeIndex.stats.symbolCount).toBeGreaterThan(5);
    expect(fixture.contexts.length).toBe(fixture.codeIndex.stats.symbolCount);
  });

  it('默认 retrieval tasks 均能解析到 target symbol', async () => {
    const fixture = await loadFixtureIndex();
    const tasks = defaultRetrievalTasks(fixture.codeIndex);
    expect(tasks.length).toBeGreaterThanOrEqual(20);
    for (const task of tasks) {
      expect(task.targetSymbolId).toMatch(/^sym_/);
    }
  });

  it('列出 chunk 与 symbol 序列化策略', () => {
    expect(listSerializationStrategies('chunk')).toEqual(['chunk-source', 'chunk-enriched']);
    expect(listSerializationStrategies('all').length).toBeGreaterThanOrEqual(6);
  });

  it('extractEmbedding 兼容 llama.cpp 两种响应', () => {
    const openAi = { data: [{ embedding: [0.1, 0.2] }] };
    const native = [{ index: 0, embedding: [[0.3, 0.4]] }];
    expect(extractEmbedding(openAi)).toEqual([0.1, 0.2]);
    expect(extractEmbedding(native)).toEqual([0.3, 0.4]);
  });
});

const live = process.env.EMBEDDING_BENCH_LIVE === '1';

describe.skipIf(!live)('tree-embedding-bench live (EMBEDDING_BENCH_LIVE=1)', () => {
  it('对 embd-gema 服务跑 synax chunk benchmark', async () => {
    const { runTreeEmbeddingBenchmark, formatBenchmarkReport } = await import('../benchmark-runner.js');
    const report = await runTreeEmbeddingBenchmark({
      maxChunks: 40,
      strategies: ['chunk-enriched'],
    });
    expect(report.embeddingDimensions).toBe(768);
    expect(report.strategies.length).toBe(1);
    console.log('\n' + formatBenchmarkReport(report));
  }, 180_000);
});
