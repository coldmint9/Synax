export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface RankedHit {
  id: string;
  similarity: number;
}

export function rankBySimilarity(
  queryVector: number[],
  candidates: Array<{ id: string; vector: number[] }>,
): RankedHit[] {
  return candidates
    .map(({ id, vector }) => ({ id, similarity: cosineSimilarity(queryVector, vector) }))
    .sort((x, y) => y.similarity - x.similarity);
}

export function recallAtK(rankedIds: string[], targetId: string, k: number): number {
  const top = rankedIds.slice(0, k);
  return top.includes(targetId) ? 1 : 0;
}

export function reciprocalRank(rankedIds: string[], targetId: string): number {
  const idx = rankedIds.indexOf(targetId);
  return idx >= 0 ? 1 / (idx + 1) : 0;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
