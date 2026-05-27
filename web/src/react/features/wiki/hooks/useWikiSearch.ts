import { useState, useEffect, useRef, useMemo } from 'react';
import { useWikiStore } from '../../../../react/state/wikiStore';
import { extractBlockText, highlightMatch } from '../lib/wikiSearchUtils';
import type { WikiBlockType } from '../../../../lib/contracts/wiki';

export interface SearchResult {
  documentId: string;
  documentTitle: string;
  blockId: string;
  blockType: WikiBlockType;
  snippet: string;
  matchIndex: number;
}

export function useWikiSearch(query: string, debounceMs = 150) {
  const documents = useWikiStore(s => s.documents);
  const blocksById = useWikiStore(s => s.blocksById);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const docMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const doc of documents) {
      map.set(doc.id, doc.title);
    }
    return map;
  }, [documents]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(() => {
      const matched: SearchResult[] = [];
      const lowerQuery = trimmed.toLowerCase();

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

      const titleDocIds = new Set(matched.map(r => `${r.documentId}:${r.blockId}`));

      for (const block of Object.values(blocksById)) {
        if (matched.length >= 50) break;
        const text = extractBlockText(block);
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(lowerQuery);
        if (idx === -1) continue;
        const key = `${block.documentId}:${block.id}`;
        if (titleDocIds.has(key)) continue;

        const m = highlightMatch(text, trimmed);
        matched.push({
          documentId: block.documentId,
          documentTitle: docMap.get(block.documentId) ?? '',
          blockId: block.id,
          blockType: block.blockType,
          snippet: m ? `${m.before}${m.match}${m.after}` : text.slice(0, 120),
          matchIndex: idx,
        });
      }

      matched.sort((a, b) => a.matchIndex - b.matchIndex);
      setResults(matched);
      setLoading(false);
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, documents, blocksById, docMap, debounceMs]);

  return { results, loading };
}
