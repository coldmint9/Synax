import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseRepositoryFallback } from '../../services/analyzer/parser.js';
import type { CodeMapCodeIndex } from '../../services/contracts/code-map.js';
import type { ChunkEntry, FileEntry, SymbolEntry } from '../../services/contracts/forest.js';

import type { ChunkContext, ParsedCorpusIndex, SymbolContext } from './contracts.js';
import { buildSymbolContexts } from './fixtures.js';

const MAX_CHUNK_SOURCE_CHARS = 900;
const MAX_EMBED_TEXT_CHARS = 1_200;

export interface LoadCorpusOptions {
  repoRoot?: string;
  maxChunks?: number;
}

export function resolveRepoRoot(repoRoot?: string): string {
  return path.resolve(repoRoot ?? process.cwd());
}

export async function loadRepositoryCorpus(
  options: LoadCorpusOptions = {},
): Promise<ParsedCorpusIndex> {
  const repoRoot = resolveRepoRoot(options.repoRoot);
  const parsed = await parseRepositoryFallback(repoRoot);
  const fileTextById = new Map(parsed.files.map((f) => [f.entry.id, f.text]));
  const chunkContexts = buildChunkContexts(parsed.codeIndex, fileTextById);

  let contexts = chunkContexts;
  if (options.maxChunks != null && options.maxChunks > 0) {
    contexts = contexts
      .sort((a, b) => a.file.path.localeCompare(b.file.path))
      .slice(0, options.maxChunks);
  }

  return {
    repoRoot,
    codeIndex: parsed.codeIndex,
    chunkContexts: contexts,
    symbolContexts: buildSymbolContexts(parsed.codeIndex),
  };
}

export function buildChunkContexts(
  index: CodeMapCodeIndex,
  fileTextById: Map<string, string>,
): ChunkContext[] {
  const fileById = new Map(index.files.map((f) => [f.id, f]));
  const symbolById = new Map(index.symbols.map((s) => [s.id, s]));
  const symbolContexts = buildSymbolContexts(index);
  const graphBySymbol = new Map(symbolContexts.map((c) => [c.symbol.id, c]));

  return index.chunks
    .map((chunk) => {
      const file = fileById.get(chunk.fileId);
      if (!file) return null;
      const text = fileTextById.get(chunk.fileId);
      if (text == null) return null;
      const symbols = chunk.symbolIds
        .map((id) => symbolById.get(id))
        .filter((s): s is SymbolEntry => s != null);
      const primary = symbols[0];
      const graph = primary ? graphBySymbol.get(primary.id) : undefined;
      return {
        chunk,
        file,
        symbols,
        sourceText: sliceSourceByRange(text, chunk.range.startLine, chunk.range.endLine),
        callees: graph?.callees ?? [],
        callers: graph?.callers ?? [],
        imports: graph?.imports ?? [],
      } satisfies ChunkContext;
    })
    .filter((ctx): ctx is ChunkContext => ctx !== null);
}

export function sliceSourceByRange(text: string, startLine: number, endLine: number): string {
  const lines = text.split(/\r?\n/);
  const slice = lines.slice(Math.max(0, startLine - 1), endLine);
  const joined = slice.join('\n');
  if (joined.length <= MAX_CHUNK_SOURCE_CHARS) return joined;
  return `${joined.slice(0, MAX_CHUNK_SOURCE_CHARS - 1)}…`;
}

export function corpusFingerprint(index: CodeMapCodeIndex): string {
  const payload = [
    index.indexId,
    String(index.stats.fileCount),
    String(index.stats.chunkCount),
    String(index.stats.symbolCount),
    String(index.updatedAt),
  ].join(':');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function chunkContainsSymbol(ctx: ChunkContext, symbolId: string): boolean {
  return ctx.chunk.symbolIds.includes(symbolId);
}

export function findChunksForSymbol(
  contexts: ChunkContext[],
  symbolId: string,
): ChunkContext[] {
  return contexts.filter((c) => chunkContainsSymbol(c, symbolId));
}

export function formatCorpusStats(corpus: ParsedCorpusIndex): string {
  const s = corpus.codeIndex.stats;
  return `${s.fileCount} files, ${s.symbolCount} symbols, ${s.chunkCount} chunks (indexed ${corpus.chunkContexts.length})`;
}
