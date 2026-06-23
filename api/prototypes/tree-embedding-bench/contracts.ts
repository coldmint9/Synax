import type { CodeMapCallEdge, CodeMapCodeIndex, CodeMapImport } from '../../services/contracts/code-map.js';
import type { FileEntry, SymbolEntry } from '../../services/contracts/forest.js';

/** 将语法树分析 chunk 序列化为 embedding 输入文本的策略 */
export type SerializationStrategy =
  | 'chunk-source'
  | 'chunk-enriched'
  | 'signature'
  | 'symbol-card'
  | 'skeleton'
  | 'graph-context';

export interface ChunkContext {
  chunk: import('../../services/contracts/forest.js').ChunkEntry;
  file: FileEntry;
  symbols: SymbolEntry[];
  sourceText: string;
  callees: string[];
  callers: string[];
  imports: string[];
}

export interface SymbolContext {
  symbol: SymbolEntry;
  file: FileEntry;
  callees: string[];
  callers: string[];
  imports: string[];
}

export interface EmbeddingRecord {
  id: string;
  symbolId: string;
  strategy: SerializationStrategy;
  text: string;
  vector?: number[];
}

export interface RetrievalTask {
  id: string;
  query: string;
  /** 期望检索到的 symbol id */
  targetSymbolId: string;
  /** 干扰项 symbol id（同 corpus 内其他符号） */
  distractorSymbolIds?: string[];
}

export interface StrategyBenchmarkResult {
  strategy: SerializationStrategy;
  corpusSize: number;
  taskCount: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  avgLatencyMs: number;
  avgPositiveSimilarity: number;
  avgNegativeSimilarity: number;
}

export interface BenchmarkReport {
  embeddingBaseUrl: string;
  embeddingDimensions: number;
  strategies: StrategyBenchmarkResult[];
  tasks: Array<{
    taskId: string;
    query: string;
    targetSymbolId: string;
    perStrategy: Record<
      SerializationStrategy,
      { rank: number; topSymbolId: string; similarity: number }
    >;
  }>;
  totalDurationMs: number;
}

export interface ParsedFixtureIndex {
  workDir: string;
  codeIndex: CodeMapCodeIndex;
  contexts: SymbolContext[];
}

export interface ParsedCorpusIndex {
  repoRoot: string;
  codeIndex: CodeMapCodeIndex;
  chunkContexts: ChunkContext[];
  symbolContexts: SymbolContext[];
}

export type { CodeMapCallEdge, CodeMapCodeIndex, CodeMapImport, FileEntry, SymbolEntry };
