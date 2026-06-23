/**
 * Smoke：Synax 全库 chunk embedding（需 embd-gema）
 *
 *   npx tsx api/__smoke__/tree-embedding-bench-smoke.ts
 *   npx tsx api/__smoke__/tree-embedding-bench-smoke.ts --limit 100
 */
process.env.SYNAX_SCAN_IN_PROCESS = '1';

const limitArg = process.argv.indexOf('--limit');
const maxChunks = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined;

const { loadRepositoryCorpus, formatCorpusStats } = await import(
  '../prototypes/tree-embedding-bench/corpus-loader.js'
);
const { runTreeEmbeddingBenchmark, formatBenchmarkReport } = await import(
  '../prototypes/tree-embedding-bench/benchmark-runner.js'
);

const corpus = await loadRepositoryCorpus({ maxChunks });
console.log('Corpus:', formatCorpusStats(corpus));

const report = await runTreeEmbeddingBenchmark({
  maxChunks,
  strategies: ['chunk-enriched'],
});
console.log('\n' + formatBenchmarkReport(report));
