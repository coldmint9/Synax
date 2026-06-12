import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import { wikiStore } from '../wiki-store.js';
import { searchWikiDocuments } from '../wiki-fts.js';

export function createWikiExplorerTools(): RegisteredTool[] {
  const listDocumentsTool: RegisteredTool = {
    id: 'wiki.list_documents',
    label: 'List Wiki Documents',
    description: 'List all document metadata under a given wiki snapshot.',
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
      const items = docs.map(d => ({
        id: d.id,
        title: d.title,
        docType: d.docType,
        parentId: d.parentId,
        hasContent: d.contentMd.trim().length > 0,
        sortOrder: d.sortOrder,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      }));
      return { result: { snapshotId: args.snapshotId, documents: items }, displaySummary: `Listed ${items.length} wiki documents`, artifacts: [] };
    },
  };

  const readDocumentTool: RegisteredTool = {
    id: 'wiki.read_document',
    label: 'Read Wiki Document',
    description: 'Read the full markdown content of a wiki document by its ID.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documentId: z.string().min(1).describe('The wiki document ID to read.'),
    }),
    async execute(input) {
      const args = input.args as { documentId: string };
      const doc = await wikiStore.getDocument(args.documentId);
      if (!doc) {
        return { result: { error: 'Document not found.' }, displaySummary: 'Document not found', artifacts: [] };
      }
      return {
        result: {
          documentId: doc.id,
          title: doc.title,
          contentMd: doc.contentMd,
          references: doc.references,
        },
        displaySummary: `Read document "${doc.title}"`,
        artifacts: [],
      };
    },
  };

  const searchContentTool: RegisteredTool = {
    id: 'wiki.search_content',
    label: 'Search Wiki Content',
    description: 'Search wiki document content by keyword.',
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
      const results = searchWikiDocuments({ projectId: args.projectId, query: args.query, limit: 20 });
      const snapshot = await wikiStore.getLatestSnapshot(args.projectId);
      const docTitleMap = new Map<string, string>();
      if (snapshot) {
        for (const d of await wikiStore.getDocumentsBySnapshot(snapshot.id)) {
          docTitleMap.set(d.id, d.title);
        }
      }
      const matches = results.map(r => ({
        documentId: r.documentId,
        documentTitle: docTitleMap.get(r.documentId) ?? '',
        snippet: r.snippet,
      }));
      return { result: { matches, total: matches.length }, displaySummary: `Found ${matches.length} matches for "${args.query}"`, artifacts: [] };
    },
  };

  return [listDocumentsTool, readDocumentTool, searchContentTool];
}
