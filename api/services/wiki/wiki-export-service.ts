// ---------------------------------------------------------------------------
// api/services/wiki/wiki-export-service.ts — Wiki → Markdown 导出
// ---------------------------------------------------------------------------

import { wikiStore } from './wiki-store.js';
import type { WikiDocument, WikiReference, MarkdownExportResult } from './contracts.js';

function formatReferences(references: WikiReference[]): string {
  if (references.length === 0) return '';
  const lines = references.map(ref => {
    const loc = ref.startLine != null
      ? `${ref.filePath}:${ref.startLine}${ref.endLine != null ? `-${ref.endLine}` : ''}`
      : ref.filePath;
    const sym = ref.symbol ? ` (${ref.symbol})` : '';
    return `- \`${loc}\`${sym}`;
  });
  return `\n## References\n\n${lines.join('\n')}\n`;
}

function documentToMarkdown(doc: WikiDocument, includeSourceRefs: boolean): string {
  const lines: string[] = [`# ${doc.title}\n`, doc.contentMd.trim()];
  if (includeSourceRefs && doc.references.length > 0) {
    lines.push(formatReferences(doc.references).trim());
  }
  return lines.filter(Boolean).join('\n\n') + '\n';
}

export const wikiExportService = {
  async exportSnapshot(
    snapshotId: string,
    opts: { includeSourceRefs?: boolean } = {},
  ): Promise<MarkdownExportResult> {
    const tree = await wikiStore.getSnapshotTree(snapshotId);
    if (!tree) throw new Error(`WikiSnapshot not found: ${snapshotId}`);

    const { snapshot, documents } = tree;
    const includeSourceRefs = opts.includeSourceRefs ?? false;

    const sections = documents
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(doc => documentToMarkdown(doc, includeSourceRefs));

    const content = sections.join('\n---\n\n');
    const fileName = `wiki-${snapshot.projectId}-r${snapshot.revision}.md`;

    return { fileName, content, snapshotId, revision: snapshot.revision };
  },

  async exportDocument(
    documentId: string,
    opts: { includeSourceRefs?: boolean } = {},
  ): Promise<MarkdownExportResult> {
    const doc = await wikiStore.getDocument(documentId);
    if (!doc) throw new Error(`WikiDocument not found: ${documentId}`);

    const snapshot = await wikiStore.getSnapshot(doc.snapshotId);
    if (!snapshot) throw new Error(`WikiSnapshot not found for document: ${documentId}`);

    const content = documentToMarkdown(doc, opts.includeSourceRefs ?? true);
    const fileName = `wiki-doc-${documentId}.md`;

    return { fileName, content, snapshotId: snapshot.id, revision: snapshot.revision };
  },
};
