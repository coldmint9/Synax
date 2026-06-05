import { useState, useEffect, useRef } from 'react';
import { useWikiStore } from '../../../../react/state/wikiStore';
import { wikiApi, type WikiSearchApiResult } from '../../../../lib/api/wiki';
import type { WikiBlockType } from '../../../../lib/contracts/wiki';

export interface SearchResult {
  documentId: string;
  documentTitle: string;
  blockId: string;
  blockType: WikiBlockType;
  snippet: string;
  matchIndex: number;
}

export function useWikiSearch(query: string, debounceMs = 200) {
  const snapshot = useWikiStore(s => s.snapshot);
  const projectId = snapshot?.projectId ?? null;
  const documents = useWikiStore(s => s.documents);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(async () => {
      // Cancel any in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // If no projectId, fall back to client-side title search
      if (!projectId) {
        const lowerQuery = trimmed.toLowerCase();
        const matched: SearchResult[] = [];
        for (const doc of documents) {
          if (doc.title.toLowerCase().includes(lowerQuery)) {
            const firstBlockId = doc.blockIds[0];
            if (firstBlockId) {
              matched.push({
                documentId: doc.id,
                documentTitle: doc.title,
                blockId: firstBlockId,
                blockType: 'heading',
                snippet: doc.title,
                matchIndex: -1,
              });
            }
          }
        }
        setResults(matched);
        setLoading(false);
        return;
      }

      try {
        const data = await wikiApi.search(projectId, trimmed, { limit: 50 });
        if (controller.signal.aborted) return;

        const mapped: SearchResult[] = data.results.map(r => ({
          documentId: r.documentId,
          documentTitle: r.documentTitle,
          blockId: r.blockId,
          blockType: r.blockType as WikiBlockType,
          snippet: r.snippet,
          matchIndex: 0,
        }));

        // Also add document title matches not already in results
        const lowerQuery = trimmed.toLowerCase();
        const resultBlockIds = new Set(mapped.map(r => r.blockId));
        for (const doc of documents) {
          if (doc.title.toLowerCase().includes(lowerQuery)) {
            const firstBlockId = doc.blockIds[0];
            if (firstBlockId && !resultBlockIds.has(firstBlockId)) {
              mapped.unshift({
                documentId: doc.id,
                documentTitle: doc.title,
                blockId: firstBlockId,
                blockType: 'heading',
                snippet: doc.title,
                matchIndex: -1,
              });
            }
          }
        }

        setResults(mapped);
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [query, projectId, documents, debounceMs]);

  return { results, loading };
}
