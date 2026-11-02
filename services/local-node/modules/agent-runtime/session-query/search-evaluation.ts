import type { RuntimeMessageRole } from '../contracts.js';
import {
  MAX_MATCHES_PER_TERM,
  normalizeSearchText,
  segmentAt,
  type SearchSegment,
  type SearchSegmentKind,
  type SessionSearchDocument,
} from './search-documents.js';

/** More terms narrow a conversation query; six is already an AND of six scans. */
export const MAX_QUERY_TERMS = 6;
export const MAX_QUERY_CHARS = 200;

const SNIPPET_LEAD_CHARS = 60;
const SNIPPET_TRAIL_CHARS = 100;

/**
 * Space-separated keywords, case/width folded. Each term must match, so typing
 * another word narrows the result set instead of OR-ing unrelated sessions in.
 */
export function queryTerms(query: string): string[] {
  const normalized = normalizeSearchText(query.slice(0, MAX_QUERY_CHARS));
  if (!normalized) return [];
  return [...new Set(normalized.split(' ').filter(Boolean))].slice(
    0,
    MAX_QUERY_TERMS,
  );
}

export interface SessionSearchMatch {
  kind: SearchSegmentKind;
  messageId: string | null;
  role: RuntimeMessageRole | null;
  createdAt: string | null;
  /** Text around the first match, with the surrounding message as context. */
  snippet: string;
  /** Occurrences across the document, capped: it only ranks equally recent rows. */
  matchCount: number;
}

/** Title beats prompt beats a message when a session matches in several places. */
export const SEARCH_KIND_ORDER: Record<SearchSegmentKind, number> = {
  title: 0,
  prompt: 1,
  message: 2,
};

function firstIndexInSegment(
  document: SessionSearchDocument,
  segment: SearchSegment,
  terms: readonly string[],
): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const term of terms) {
    const index = document.haystack.indexOf(term, segment.start);
    if (index < 0 || index >= segment.end) continue;
    if (!best || index < best.index) best = { index, length: term.length };
  }
  return best;
}

function snippetFor(
  document: SessionSearchDocument,
  segment: SearchSegment,
  terms: readonly string[],
): string {
  const hit = firstIndexInSegment(document, segment, terms);
  if (!hit) return document.haystack.slice(segment.start, segment.end);
  const start = Math.max(segment.start, hit.index - SNIPPET_LEAD_CHARS);
  const end = Math.min(
    segment.end,
    hit.index + hit.length + SNIPPET_TRAIL_CHARS,
  );
  return [
    start > segment.start ? '…' : '',
    document.haystack.slice(start, end),
    end < segment.end ? '…' : '',
  ].join('');
}

/**
 * Every term must appear somewhere in the session. The best-scoring segment
 * supplies the snippet, so a title hit stays a title hit instead of jumping to
 * an unrelated message that happens to contain the other keyword.
 */
export function evaluateDocument(
  document: SessionSearchDocument,
  terms: readonly string[],
): SessionSearchMatch | null {
  if (!terms.length || !document.segments.length) return null;
  const scores = new Map<SearchSegment, number>();
  let matchCount = 0;
  for (const term of terms) {
    let from = 0;
    let occurrences = 0;
    const matchedSegments = new Set<SearchSegment>();
    while (occurrences < MAX_MATCHES_PER_TERM) {
      const index = document.haystack.indexOf(term, from);
      if (index < 0) break;
      occurrences += 1;
      const segment = segmentAt(document, index);
      if (segment && !matchedSegments.has(segment)) {
        matchedSegments.add(segment);
        scores.set(segment, (scores.get(segment) ?? 0) + 1);
      }
      from = index + Math.max(term.length, 1);
    }
    // One missing keyword drops the session: the query is an AND of keywords.
    if (!occurrences) return null;
    matchCount += occurrences;
  }

  let best: SearchSegment | null = null;
  let bestScore = 0;
  for (const [segment, score] of scores) {
    if (
      !best ||
      score > bestScore ||
      (score === bestScore &&
        (SEARCH_KIND_ORDER[segment.kind] < SEARCH_KIND_ORDER[best.kind] ||
          (SEARCH_KIND_ORDER[segment.kind] === SEARCH_KIND_ORDER[best.kind] &&
            segment.start < best.start)))
    ) {
      best = segment;
      bestScore = score;
    }
  }
  if (!best) return null;

  return {
    kind: best.kind,
    messageId: best.messageId,
    role: best.role,
    createdAt: best.createdAt,
    snippet: snippetFor(document, best, terms),
    matchCount,
  };
}
