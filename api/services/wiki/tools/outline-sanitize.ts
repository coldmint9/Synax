import type { WikiOutlineEntry, WikiOutlineNodeKind } from './contracts.js';
import { isSectionEntry } from './outline-node.js';

type RawOutlineDocument = {
  id: string;
  nodeKind?: WikiOutlineNodeKind;
  docType?: WikiOutlineEntry['docType'];
  title: string;
  parentId?: string;
  sortOrder?: number;
  targetFiles?: string[];
  keyQuestions?: string[];
};

/**
 * Programmatic cleanup of auto-fixable issues before validation:
 * drop hallucinated targetFiles, dedupe IDs, normalize missing arrays.
 */
export function sanitizeOutline(
  documents: RawOutlineDocument[],
  validPaths: Set<string>,
): WikiOutlineEntry[] {
  const seen = new Set<string>();
  const result: WikiOutlineEntry[] = [];

  for (const doc of documents) {
    let id = doc.id.trim() || `doc-${result.length + 1}`;
    while (seen.has(id)) id = `${id}-x`;
    seen.add(id);

    const parentId = doc.parentId?.trim();
    const nodeKind = doc.nodeKind ?? 'document';
    const isSection = isSectionEntry({ nodeKind });
    const entry: WikiOutlineEntry = {
      id,
      nodeKind,
      docType: doc.docType ?? 'landscape',
      title: doc.title.trim(),
      sortOrder: doc.sortOrder,
      targetFiles: isSection ? [] : (doc.targetFiles ?? []).filter(p => validPaths.has(p)),
      keyQuestions: isSection ? [] : (doc.keyQuestions ?? []).map(q => q.trim()).filter(Boolean),
    };
    if (parentId) entry.parentId = parentId;
    result.push(entry);
  }

  return result;
}
