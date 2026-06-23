import type {
  BenchmarkReport,
  RetrievalTask,
  SerializationStrategy,
  StrategyBenchmarkResult,
} from './contracts.js';
import { corpusFingerprint, loadRepositoryCorpus, resolveRepoRoot } from './corpus-loader.js';
import { EmbeddingClient } from './embedding-client.js';
import { loadEvalTasks, SYNAX_EVAL_SET_PATH } from './eval-set.js';
import { mean } from './metrics.js';
import { CodeChunkRetrievalIndex } from './retrieval-index.js';
import { defaultChunkStrategy, listSerializationStrategies } from './serializers.js';

export interface RunBenchmarkOptions {
  baseUrl?: string;
  repoRoot?: string;
  maxChunks?: number;
  strategies?: SerializationStrategy[];
  tasks?: RetrievalTask[];
  evalSetPath?: string;
  useCache?: boolean;
}

export async function runTreeEmbeddingBenchmark(
  options: RunBenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const started = Date.now();
  const client = new EmbeddingClient({ baseUrl: options.baseUrl });
  const healthy = await client.health();
  if (!healthy) {
    throw new Error(
      `Embedding 服务不可用 (${options.baseUrl ?? 'http://127.0.0.1:8080'})。请先启动 embd-gema。`,
    );
  }

  const corpus = await loadRepositoryCorpus({
    repoRoot: resolveRepoRoot(options.repoRoot),
    maxChunks: options.maxChunks,
  });
  const tasks =
    options.tasks ??
    loadEvalTasks(corpus.codeIndex, options.evalSetPath ?? SYNAX_EVAL_SET_PATH);
  const strategies = options.strategies ?? [defaultChunkStrategy(), ...listSerializationStrategies('chunk')];

  const strategyResults: StrategyBenchmarkResult[] = [];
  const taskDetails: BenchmarkReport['tasks'] = [];
  let dimensions = 0;

  for (const strategy of strategies) {
    const { index } = await CodeChunkRetrievalIndex.buildFromCorpus(corpus, {
      baseUrl: options.baseUrl,
      strategy,
      useCache: options.useCache,
    });
    if (index.chunks.length === 0) continue;
    dimensions = index.dimensions;

    const latencies: number[] = [];
    const r1: number[] = [];
    const r3: number[] = [];
    const r5: number[] = [];
    const rr: number[] = [];
    const posSim: number[] = [];
    const negSim: number[] = [];

    for (const task of tasks) {
      const t0 = Date.now();
      const { hits, rankedIds } = await index.searchRanked(task.query, 5, client);
      latencies.push(Date.now() - t0);

      const rank = index.symbolRankInResults(rankedIds, task.targetSymbolId);
      const rankedHits = hits;
      r1.push(rank > 0 && rank <= 1 ? 1 : 0);
      r3.push(rank > 0 && rank <= 3 ? 1 : 0);
      r5.push(rank > 0 && rank <= 5 ? 1 : 0);
      rr.push(rank > 0 ? 1 / rank : 0);

      const targetHit = rankedHits.find((h) => h.symbolIds.includes(task.targetSymbolId));
      if (targetHit) posSim.push(targetHit.similarity);
      const negatives = rankedHits.filter((h) => !h.symbolIds.includes(task.targetSymbolId)).slice(0, 3);
      negSim.push(mean(negatives.map((n) => n.similarity)));

      let detail = taskDetails.find((d) => d.taskId === task.id);
      if (!detail) {
        detail = {
          taskId: task.id,
          query: task.query,
          targetSymbolId: task.targetSymbolId,
          perStrategy: {} as BenchmarkReport['tasks'][0]['perStrategy'],
        };
        taskDetails.push(detail);
      }
      detail.perStrategy[strategy] = {
        rank,
        topSymbolId: rankedHits[0]?.symbolIds[0] ?? '',
        similarity: targetHit?.similarity ?? 0,
      };
    }

    strategyResults.push({
      strategy,
      corpusSize: index.chunks.length,
      taskCount: tasks.length,
      recallAt1: mean(r1),
      recallAt3: mean(r3),
      recallAt5: mean(r5),
      mrr: mean(rr),
      avgLatencyMs: mean(latencies),
      avgPositiveSimilarity: mean(posSim),
      avgNegativeSimilarity: mean(negSim),
    });
  }

  return {
    embeddingBaseUrl: options.baseUrl ?? 'http://127.0.0.1:8080',
    embeddingDimensions: dimensions,
    strategies: strategyResults,
    tasks: taskDetails,
    totalDurationMs: Date.now() - started,
  };
}

export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines = [
    `Tree Embedding Benchmark (Synax chunk corpus)`,
    `  service: ${report.embeddingBaseUrl}`,
    `  dimensions: ${report.embeddingDimensions}`,
    `  duration: ${report.totalDurationMs}ms`,
    '',
    'Strategy           R@1    R@3    R@5    MRR   posSim  negSim  latency',
    '─────────────────────────────────────────────────────────────────────',
  ];
  for (const s of report.strategies) {
    lines.push(
      `${s.strategy.padEnd(18)} ${pct(s.recallAt1)}  ${pct(s.recallAt3)}  ${pct(s.recallAt5)}  ${pct(s.mrr)}  ${s.avgPositiveSimilarity.toFixed(3)}  ${s.avgNegativeSimilarity.toFixed(3)}  ${s.avgLatencyMs.toFixed(0)}ms`,
    );
  }
  return lines.join('\n');
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0).padStart(3)}%`;
}

export { corpusFingerprint };
