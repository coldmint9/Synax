import type { WikiSearchResult } from '../wiki-fts.js';
import { wikiStore } from '../wiki-store.js';
import { buildDocumentTitleMap } from './agent-context.js';

export interface WikiSearchMatch {
  documentId: string;
  documentTitle: string;
  snippet: string;
  rank: number;
}

export async function enrichWikiSearchMatches(
  results: WikiSearchResult[],
  opts: { snapshotId?: string; projectId: string },
): Promise<WikiSearchMatch[]> {
  let docTitleMap = new Map<string, string>();

  if (opts.snapshotId) {
    const docs = await wikiStore.getDocumentsBySnapshot(opts.snapshotId);
    docTitleMap = buildDocumentTitleMap(docs);
  } else if (results.length > 0) {
    for (const hit of results) {
      const doc = await wikiStore.getDocument(hit.documentId);
      if (doc) docTitleMap.set(doc.id, doc.title);
    }
  }

  return results.map((r) => ({
    documentId: r.documentId,
    documentTitle: docTitleMap.get(r.documentId) ?? '',
    snippet: r.snippet,
    rank: r.rank,
  }));
}
