export type {
  BenchmarkReport,
  ChunkContext,
  EmbeddingRecord,
  ParsedCorpusIndex,
  ParsedFixtureIndex,
  RetrievalTask,
  SerializationStrategy,
  StrategyBenchmarkResult,
  SymbolContext,
} from './contracts.js';
export { EmbeddingClient, DEFAULT_EMBEDDING_BASE_URL, extractEmbedding } from './embedding-client.js';
export {
  buildChunkContexts,
  corpusFingerprint,
  formatCorpusStats,
  loadRepositoryCorpus,
  resolveRepoRoot,
  sliceSourceByRange,
} from './corpus-loader.js';
export {
  DEFAULT_EVAL_SET_PATH,
  SYNAX_EVAL_SET_PATH,
  groupEvalRowsByCase,
  loadEvalSetFile,
  loadEvalTasks,
  resolveEvalSet,
  resolveSymbolId,
  summarizeEvalSet,
} from './eval-set.js';
export type {
  EvalCase,
  EvalDifficulty,
  EvalQuery,
  EvalRunRow,
  EvalSetFile,
  EvalSetSummary,
  EvalTarget,
  ResolvedEvalCase,
  ResolvedEvalTask,
} from './eval-set.js';
export {
  buildSymbolContexts,
  defaultRetrievalTasks,
  getFixtureSamplesDir,
  loadFixtureIndex,
} from './fixtures.js';
export {
  hashEmbedText,
  indexCacheDir,
  loadIndexCache,
  saveIndexCache,
} from './index-cache.js';
export { cosineSimilarity, mean, rankBySimilarity, recallAtK, reciprocalRank } from './metrics.js';
export {
  CodeChunkRetrievalIndex,
  formatSearchHits,
  hitContainsSymbol,
  recallAtKForSymbol,
  reciprocalRankForSymbol,
} from './retrieval-index.js';
export type { BuildIndexResult, IndexedChunk, SearchHit } from './retrieval-index.js';
export {
  defaultChunkStrategy,
  isChunkStrategy,
  listSerializationStrategies,
  serializeChunkContext,
  serializeForEmbedding,
  serializeSymbolContext,
} from './serializers.js';
export { formatBenchmarkReport, runTreeEmbeddingBenchmark } from './benchmark-runner.js';
