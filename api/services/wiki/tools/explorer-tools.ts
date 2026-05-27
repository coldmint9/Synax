import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import { wikiStore } from '../wiki-store.js';

export function createWikiExplorerTools(): RegisteredTool[] {
  const listDocumentsTool: RegisteredTool = {
    id: 'wiki.list_documents',
    label: 'List Wiki Documents',
    description: 'List all document metadata under a given wiki snapshot. Returns id, title, docType, parentId, blockIds, sortOrder, and timestamps.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      snapshotId: z.string().min(1).describe('The snapshot ID to list documents for.'),
    }),
    async execute(input) {
      const args = input.args as { snapshotId: string };
      const docs = await wikiStore.getDocumentsBySnapshot(args.snapshotId);
      if (docs.length === 0) {
        return { result: { documents: [], message: 'No documents found in this snapshot.' }, displaySummary: 'No documents', artifacts: [] };
      }
      const items = docs.map(d => ({ id: d.id, title: d.title, docType: d.docType, parentId: d.parentId, blockIds: d.blockIds, sortOrder: d.sortOrder, createdAt: d.createdAt, updatedAt: d.updatedAt }));
      return { result: { snapshotId: args.snapshotId, documents: items }, displaySummary: `Listed ${items.length} wiki documents`, artifacts: [] };
    },
  };

  const readDocumentTool: RegisteredTool = {
    id: 'wiki.read_document',
    label: 'Read Wiki Document',
    description: 'Read the full content of a wiki document by its ID. Returns all blocks with their content.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documentId: z.string().min(1).describe('The wiki document ID to read.'),
    }),
    async execute(input) {
      const args = input.args as { documentId: string };
      const blocks = await wikiStore.getBlocksByDocument(args.documentId);
      if (blocks.length === 0) {
        return { result: { error: 'Document not found or has no content.' }, displaySummary: 'Document empty', artifacts: [] };
      }
      const content = blocks.map(b => ({ id: b.id, blockType: b.blockType, content: b.content }));
      return { result: { documentId: args.documentId, blocks: content }, displaySummary: `Read ${blocks.length} blocks`, artifacts: [] };
    },
  };

  const searchContentTool: RegisteredTool = {
    id: 'wiki.search_content',
    label: 'Search Wiki Content',
    description: 'Search wiki document content by keyword. Returns matching blocks with surrounding context.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      projectId: z.string().min(1).describe('The project ID to search within.'),
      query: z.string().min(1).describe('Search keyword or phrase.'),
    }),
    async execute(input) {
      const args = input.args as { projectId: string; query: string };
      const snapshot = await wikiStore.getLatestSnapshot(args.projectId);
      if (!snapshot) {
        return { result: { matches: [], message: 'No wiki snapshot found.' }, displaySummary: 'No wiki found', artifacts: [] };
      }
      const tree = await wikiStore.getSnapshotTree(snapshot.id);
      if (!tree) {
        return { result: { matches: [] }, displaySummary: 'No content', artifacts: [] };
      }
      const queryLower = args.query.toLowerCase();
      const matches: Array<{ documentId: string; documentTitle: string; blockId: string; blockType: string; snippet: string }> = [];
      const docById = new Map(tree.documents.map(d => [d.id, d]));
      for (const block of tree.blocks) {
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        const idx = text.toLowerCase().indexOf(queryLower);
        if (idx !== -1) {
          const doc = docById.get(block.documentId);
          const start = Math.max(0, idx - 80);
          const end = Math.min(text.length, idx + args.query.length + 80);
          matches.push({ documentId: block.documentId, documentTitle: doc?.title ?? '', blockId: block.id, blockType: block.blockType, snippet: text.slice(start, end) });
        }
        if (matches.length >= 20) break;
      }
      return { result: { matches, total: matches.length }, displaySummary: `Found ${matches.length} matches for "${args.query}"`, artifacts: [] };
    },
  };

  return [listDocumentsTool, readDocumentTool, searchContentTool];
}
