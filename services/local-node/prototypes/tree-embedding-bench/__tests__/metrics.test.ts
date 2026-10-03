import { describe, expect, it } from 'vitest';

import { cosineSimilarity, mean, rankBySimilarity, recallAtK, reciprocalRank } from '../metrics.js';

describe('embedding metrics', () => {
  it('cosineSimilarity 对相同向量返回 1', () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it('cosineSimilarity 对正交向量返回 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('rankBySimilarity 按相似度降序排列', () => {
    const query = [1, 0];
    const ranked = rankBySimilarity(query, [
      { id: 'a', vector: [0, 1] },
      { id: 'b', vector: [1, 0] },
      { id: 'c', vector: [0.9, 0.1] },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('recallAtK / reciprocalRank', () => {
    const ids = ['x', 'target', 'y'];
    expect(recallAtK(ids, 'target', 1)).toBe(0);
    expect(recallAtK(ids, 'target', 2)).toBe(1);
    expect(reciprocalRank(ids, 'target')).toBe(0.5);
    expect(reciprocalRank(ids, 'missing')).toBe(0);
  });

  it('mean', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
  });
});
