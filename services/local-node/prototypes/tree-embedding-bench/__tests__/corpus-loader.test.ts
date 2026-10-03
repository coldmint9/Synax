import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadRepositoryCorpus, resolveRepoRoot, sliceSourceByRange } from '../corpus-loader.js';
import { serializeChunkContext } from '../serializers.js';

// Exercise the real parser without making correctness depend on the size of the
// developer checkout. maxChunks caps returned contexts, not files to parse.
const FILE_COUNT = 120;
let repoRoot: string;
const moduleName = (index: number) => `module-${String(index).padStart(3, '0')}`;

beforeAll(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-corpus-loader-'));
  fs.mkdirSync(path.join(repoRoot, 'src'));
  for (let index = FILE_COUNT - 1; index >= 0; index--) {
    const source = index === 0
      ? 'export function value0() { return 0; }\n'
      : `import { value${index - 1} } from './${moduleName(index - 1)}';\nexport function value${index}() { return value${index - 1}() + 1; }\n`;
    fs.writeFileSync(path.join(repoRoot, 'src', `${moduleName(index)}.ts`), source);
  }
});

afterAll(() => {
  if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('corpus-loader', () => {
  it('defaults to cwd and resolves explicit relative roots without changing cwd', () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);
    try {
      expect(resolveRepoRoot()).toBe(repoRoot);
      expect(resolveRepoRoot('src')).toBe(path.join(repoRoot, 'src'));
    } finally {
      cwd.mockRestore();
    }
  });

  it('caps contexts in path order while retaining the full parsed index and symbol graph', async () => {
    const corpus = await loadRepositoryCorpus({ repoRoot, maxChunks: 20 });
    expect(corpus.repoRoot).toBe(repoRoot);
    expect(corpus.chunkContexts).toHaveLength(20);
    expect(corpus.codeIndex.stats.fileCount).toBe(FILE_COUNT);
    expect(corpus.codeIndex.files).toHaveLength(FILE_COUNT);
    expect(corpus.codeIndex.chunks.length).toBeGreaterThan(20);
    expect(corpus.codeIndex.stats.chunkCount).toBe(corpus.codeIndex.chunks.length);
    expect(corpus.symbolContexts).toHaveLength(corpus.codeIndex.symbols.length);
    const paths = corpus.chunkContexts.map(context => context.file.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    expect(paths[0]).toBe('src/module-000.ts');
    for (const context of corpus.chunkContexts) {
      const source = fs.readFileSync(path.join(repoRoot, context.file.path), 'utf8');
      expect(context.sourceText).toBe(sliceSourceByRange(source, context.chunk.range.startLine, context.chunk.range.endLine));
      expect(context.sourceText.length).toBeGreaterThan(0);
      expect(context.symbols.map(symbol => symbol.id)).toEqual(context.chunk.symbolIds);
    }
    const value1Context = corpus.symbolContexts.find(context => context.symbol.name === 'value1');
    expect(value1Context?.callees).toContain('value0');
    expect(value1Context?.callers).toContain('value2');
    expect(value1Context?.imports).toContain('./module-000');
    const value1Chunk = corpus.chunkContexts.find(context => context.symbols.some(symbol => symbol.name === 'value1'));
    expect(value1Chunk?.callees).toContain('value0');
    expect(value1Chunk?.callers).toContain('value2');
    expect(value1Chunk?.imports).toContain('./module-000');
    // The cap must not truncate symbols from the rest of the repository.
    expect(corpus.symbolContexts.some(context => context.symbol.name === 'value119')).toBe(true);
  });

  it.each([undefined, 0, -1])('returns all contexts when maxChunks is %s', async (maxChunks) => {
    const corpus = await loadRepositoryCorpus({ repoRoot, maxChunks });
    expect(corpus.chunkContexts).toHaveLength(corpus.codeIndex.stats.chunkCount);
    expect(corpus.chunkContexts.length).toBeGreaterThan(20);
  });

  it('slices inclusive one-based line ranges and normalizes CRLF', () => {
    expect(sliceSourceByRange('line1\nline2\nline3\nline4', 2, 3)).toBe('line2\nline3');
    expect(sliceSourceByRange('line1\r\nline2\r\nline3', 2, 3)).toBe('line2\nline3');
    expect(sliceSourceByRange('line1\nline2', 0, 1)).toBe('line1');
  });

  it('bounds source text without truncating a chunk at the exact limit', () => {
    expect(sliceSourceByRange('x'.repeat(900), 1, 1)).toBe('x'.repeat(900));
    expect(sliceSourceByRange('x'.repeat(901), 1, 1)).toBe(`${'x'.repeat(899)}…`);
  });

  it('serializes actual chunk source in chunk-enriched output', async () => {
    const corpus = await loadRepositoryCorpus({ repoRoot, maxChunks: 1 });
    expect(corpus.chunkContexts).toHaveLength(1);
    const serialized = serializeChunkContext(corpus.chunkContexts[0], 'chunk-enriched');
    expect(serialized).toContain('path: src/module-000.ts');
    expect(serialized).toContain('---');
    expect(serialized).toContain('export function value0() { return 0; }');
  });
});
