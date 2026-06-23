import { describe, expect, it } from 'vitest';

import { loadRepositoryCorpus, sliceSourceByRange } from '../corpus-loader.js';
import { serializeChunkContext } from '../serializers.js';

describe('corpus-loader', () => {
  it('从 Synax 仓库构建 chunk contexts', async () => {
    const corpus = await loadRepositoryCorpus({ maxChunks: 20 });
    expect(corpus.chunkContexts.length).toBe(20);
    expect(corpus.codeIndex.stats.fileCount).toBeGreaterThan(100);
    const first = corpus.chunkContexts[0];
    expect(first.sourceText.length).toBeGreaterThan(0);
    expect(first.file.path).toMatch(/\./);
  });

  it('sliceSourceByRange 按行号切片', () => {
    const text = 'line1\nline2\nline3\nline4';
    expect(sliceSourceByRange(text, 2, 3)).toBe('line2\nline3');
  });

  it('chunk-enriched 序列化包含源码', async () => {
    const corpus = await loadRepositoryCorpus({ maxChunks: 1 });
    const serialized = serializeChunkContext(corpus.chunkContexts[0], 'chunk-enriched');
    expect(serialized).toContain('path:');
    expect(serialized).toContain('---');
  });
});
