import path from 'node:path';

import type { ChunkContext, ParsedCorpusIndex, SerializationStrategy } from './contracts.js';
import { corpusFingerprint } from './corpus-loader.js';
import { EmbeddingClient } from './embedding-client.js';
import {
  hashEmbedText,
  loadIndexCache,
  saveIndexCache,
  summarizeCacheHit,
  type IndexCacheEntry,
} from './index-cache.js';
import { rankBySimilarity } from './metrics.js';
import {
  defaultChunkStrategy,
  isChunkStrategy,
  serializeForEmbedding,
  truncateForEmbedding,
} from './serializers.js';

async function embedWithTruncate(client: EmbeddingClient, text: string): Promise<number[]> {
  let candidate = text;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await client.embed(candidate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('too large') && !msg.includes('batch size')) throw err;
      candidate = truncateForEmbedding(candidate, Math.floor(candidate.length * 0.6));
      if (candidate.length < 80) throw err;
    }
  }
  return client.embed(truncateForEmbedding(text, 400));
}

export interface IndexedChunk {
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolIds: string[];
  primaryName: string;
  primaryKind: string;
  text: string;
  vector: number[];
  context: ChunkContext;
}

export interface SearchHit {
  rank: number;
  chunkId: string;
  symbolIds: string[];
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  similarity: number;
  preview?: string;
}

export interface BuildIndexOptions {
  baseUrl?: string;
  strategy?: SerializationStrategy;
  useCache?: boolean;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface BuildIndexResult {
  index: CodeChunkRetrievalIndex;
  cache: { embedded: number; reused: number };
}

export class CodeChunkRetrievalIndex {
  readonly strategy: SerializationStrategy;
  readonly dimensions: number;
  readonly repoRoot: string;
  readonly fingerprint: string;
  readonly chunks: IndexedChunk[];

  private constructor(
    repoRoot: string,
    fingerprint: string,
    strategy: SerializationStrategy,
    dimensions: number,
    chunks: IndexedChunk[],
  ) {
    this.repoRoot = repoRoot;
    this.fingerprint = fingerprint;
    this.strategy = strategy;
    this.dimensions = dimensions;
    this.chunks = chunks;
  }

  static async buildFromCorpus(
    corpus: ParsedCorpusIndex,
    options: BuildIndexOptions = {},
  ): Promise<BuildIndexResult> {
    const client = new EmbeddingClient({ baseUrl: options.baseUrl });
    const healthy = await client.health();
    if (!healthy) {
      throw new Error(
        `Embedding 服务不可用。请先启动 embd-gema (${options.baseUrl ?? 'http://127.0.0.1:8080'})`,
      );
    }

    const strategy = options.strategy ?? defaultChunkStrategy();
    const fingerprint = corpusFingerprint(corpus.codeIndex);
    const useCache = options.useCache !== false;
    const cached = useCache
      ? loadIndexCache(fingerprint, strategy, corpus.repoRoot)
      : null;

    const indexed: IndexedChunk[] = [];
    const cacheEntries: IndexCacheEntry[] = [];
    let reused = 0;
    const total = corpus.chunkContexts.length;

    for (let i = 0; i < corpus.chunkContexts.length; i += 1) {
      const ctx = corpus.chunkContexts[i];
      const text = serializeForEmbedding(ctx, strategy);
      const textHash = hashEmbedText(text);
      const label = ctx.symbols[0]?.name ?? pathLabel(ctx.file.path);

      let vector: number[] | undefined;
      const hit = cached?.get(ctx.chunk.id);
      if (hit && hit.textHash === textHash) {
        vector = hit.vector;
        reused += 1;
      } else {
        vector = await embedWithTruncate(client, text);
      }

      cacheEntries.push({ chunkId: ctx.chunk.id, textHash, vector });
      indexed.push({
        chunkId: ctx.chunk.id,
        filePath: ctx.file.path,
        startLine: ctx.chunk.range.startLine,
        endLine: ctx.chunk.range.endLine,
        symbolIds: ctx.chunk.symbolIds,
        primaryName: ctx.symbols[0]?.name ?? path.basename(ctx.file.path),
        primaryKind: ctx.symbols[0]?.kind ?? 'module',
        text,
        vector,
        context: ctx,
      });

      options.onProgress?.(i + 1, total, label);
    }

    if (useCache && indexed.length > 0) {
      saveIndexCache(
        fingerprint,
        strategy,
        corpus.repoRoot,
        indexed[0].vector.length,
        cacheEntries,
      );
    }

    const index = new CodeChunkRetrievalIndex(
      corpus.repoRoot,
      fingerprint,
      strategy,
      indexed[0]?.vector.length ?? 0,
      indexed,
    );
    return { index, cache: summarizeCacheHit(total, reused) };
  }

  async search(query: string, topK = 5, client?: EmbeddingClient): Promise<SearchHit[]> {
    const { hits } = await this.searchRanked(query, topK, client);
    return hits;
  }

  async searchRanked(
    query: string,
    topK = 5,
    client?: EmbeddingClient,
  ): Promise<{ hits: SearchHit[]; rankedIds: string[] }> {
    const embedder = client ?? new EmbeddingClient();
    const queryVector = await embedder.embed(query);
    const ranked = rankBySimilarity(
      queryVector,
      this.chunks.map((c) => ({ id: c.chunkId, vector: c.vector })),
    );
    const rankedIds = ranked.map((r) => r.id);
    const hits = this.hitsFromRanked(ranked.slice(0, topK));
    return { hits, rankedIds };
  }

  private hitsFromRanked(ranked: Array<{ id: string; similarity: number }>): SearchHit[] {
    const byId = new Map(this.chunks.map((c) => [c.chunkId, c]));
    return ranked.map((hit, idx) => {
      const chunk = byId.get(hit.id)!;
      return {
        rank: idx + 1,
        chunkId: chunk.chunkId,
        symbolIds: chunk.symbolIds,
        name: chunk.primaryName,
        kind: chunk.primaryKind,
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        similarity: hit.similarity,
        preview: chunk.context.sourceText.split('\n')[0]?.trim().slice(0, 80),
      };
    });
  }

  symbolRankInResults(rankedChunkIds: string[], targetSymbolId: string): number {
    for (let i = 0; i < rankedChunkIds.length; i += 1) {
      const chunk = this.findByChunkId(rankedChunkIds[i]);
      if (chunk?.symbolIds.includes(targetSymbolId)) return i + 1;
    }
    return -1;
  }

  async rankForSymbol(
    query: string,
    targetSymbolId: string,
    topK: number,
    client?: EmbeddingClient,
  ): Promise<{ hits: SearchHit[]; rank: number }> {
    const { hits, rankedIds } = await this.searchRanked(query, topK, client);
    return { hits, rank: this.symbolRankInResults(rankedIds, targetSymbolId) };
  }

  findBySymbolId(symbolId: string): IndexedChunk | undefined {
    return this.chunks.find((c) => c.symbolIds.includes(symbolId));
  }

  findByChunkId(chunkId: string): IndexedChunk | undefined {
    return this.chunks.find((c) => c.chunkId === chunkId);
  }

  findByName(name: string, filePath?: string): IndexedChunk | undefined {
    return this.chunks.find(
      (c) =>
        (c.primaryName === name || c.context.symbols.some((s) => s.name === name)) &&
        (!filePath || c.filePath === filePath || c.filePath.endsWith(filePath)),
    );
  }
}

/** @deprecated 使用 CodeChunkRetrievalIndex */
export type SymbolRetrievalIndex = CodeChunkRetrievalIndex;

function pathLabel(filePath: string): string {
  return path.basename(filePath);
}

export function formatSearchHits(
  hits: SearchHit[],
  highlightSymbolId?: string,
): string {
  if (hits.length === 0) return '  (无结果)';
  const lines: string[] = [];
  for (const hit of hits) {
    const mark = highlightSymbolId && hit.symbolIds.includes(highlightSymbolId) ? ' ✓' : '';
    const sim = hit.similarity.toFixed(4);
    const loc = `${hit.filePath}:${hit.startLine}-${hit.endLine}`;
    const preview = hit.preview ? ` — ${hit.preview}` : '';
    lines.push(
      `  ${String(hit.rank).padStart(2)}. [${sim}] ${loc} :: ${hit.kind} ${hit.name}${mark}${preview}`,
    );
  }
  return lines.join('\n');
}

export function hitContainsSymbol(hit: SearchHit, symbolId: string): boolean {
  return hit.symbolIds.includes(symbolId);
}

export function recallAtKForSymbol(
  hits: SearchHit[],
  targetSymbolId: string,
  k: number,
): number {
  const top = hits.slice(0, k);
  return top.some((h) => hitContainsSymbol(h, targetSymbolId)) ? 1 : 0;
}

export function reciprocalRankForSymbol(hits: SearchHit[], targetSymbolId: string): number {
  const idx = hits.findIndex((h) => hitContainsSymbol(h, targetSymbolId));
  return idx >= 0 ? 1 / (idx + 1) : 0;
}
