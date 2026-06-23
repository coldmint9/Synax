import { validateToken } from './auth.js';

export interface SearchHit {
  id: string;
  score: number;
  snippet: string;
}

export function tokenizeQuery(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/\s+/g)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((t) => t.length > 1);
}

export function rankHits(query: string, docs: Array<{ id: string; text: string }>): SearchHit[] {
  const tokens = tokenizeQuery(query);
  return docs
    .map((doc) => ({
      id: doc.id,
      score: scoreDocument(tokens, doc.text),
      snippet: doc.text.slice(0, 120),
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
}

function scoreDocument(tokens: string[], text: string): number {
  const lower = text.toLowerCase();
  return tokens.reduce((sum, t) => sum + (lower.includes(t) ? 1 : 0), 0);
}

export async function searchWithAuth(
  query: string,
  token: string,
  secret: string,
  docs: Array<{ id: string; text: string }>,
): Promise<SearchHit[]> {
  if (!validateToken(token, secret)) return [];
  return rankHits(query, docs);
}
