import { z } from 'zod';
import type { RegisteredTool, ToolExecutionInput, ToolExecutionResult } from '../../agent-runtime/contracts.js';
import { searchWikiDocuments } from '../wiki-fts.js';
import { wikiStore } from '../wiki-store.js';
import {
  buildDocumentTitleMap,
  buildWikiDocumentTree,
  resolveWikiAgentScope,
} from './agent-context.js';
import { enrichWikiSearchMatches } from './search-utils.js';
import { extractMarkdownSection } from './section-utils.js';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const MAX_BATCH_QUERIES = 10;
const DEFAULT_BATCH_LIMIT = 10;
const MAX_READ_CHARS = 48_000;
const DEFAULT_SECTION_CHARS = 12_000;

function toolError(message: string, displaySummary: string): ToolExecutionResult {
  return { result: { ok: false, error: message }, displaySummary, artifacts: [] };
}

async function resolveScope(input: ToolExecutionInput, snapshotId?: string) {
  const scope = await resolveWikiAgentScope(input.sessionId, snapshotId);
  if ('error' in scope) return scope;
  return scope;
}

async function loadTitleMap(snapshotId: string | undefined, scopeSnapshotId?: string) {
  const sid = snapshotId ?? scopeSnapshotId;
  if (!sid) return new Map<string, string>();
  const docs = await wikiStore.getDocumentsBySnapshot(sid);
  return buildDocumentTitleMap(docs);
}

export function createWikiAgentTools(): RegisteredTool[] {
  const getSnapshotTool: RegisteredTool = {
    id: 'wiki.get_snapshot',
    label: 'Get Wiki Snapshot',
    description:
      'Return the latest wiki snapshot metadata for the current project: revision, status, branch, and document count. Use first to check whether wiki content exists before search or read.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      snapshotId: z.string().optional().describe('Optional snapshot ID. Defaults to the latest snapshot.'),
    }),
    async execute(input) {
      const args = input.args as { snapshotId?: string };
      const scope = await resolveScope(input, args.snapshotId);
      if ('error' in scope) return toolError(scope.error, 'Wiki snapshot unavailable');

      const { snapshot } = scope;
      if (!snapshot) {
        return {
          result: { ok: true, snapshot: null, message: 'No wiki snapshot exists for this project yet.' },
          displaySummary: 'No wiki snapshot',
          artifacts: [],
        };
      }

      const docs = await wikiStore.getDocumentsBySnapshot(snapshot.id);
      const contentCount = docs.filter((d) => d.contentMd.trim().length > 0).length;
      const generation = await wikiStore.hasActiveGeneration(scope.projectId);

      return {
        result: {
          ok: true,
          snapshot: {
            id: snapshot.id,
            projectId: snapshot.projectId,
            revision: snapshot.revision,
            status: snapshot.status,
            branch: snapshot.branch,
            headCommitSha: snapshot.headCommitSha,
            createdAt: snapshot.createdAt,
            documentCount: docs.length,
            documentsWithContent: contentCount,
          },
          generationActive: generation.active,
          generationStatus: generation.status ?? null,
        },
        displaySummary: `Wiki snapshot r${snapshot.revision} (${snapshot.status}), ${contentCount}/${docs.length} docs with content`,
        artifacts: [],
      };
    },
  };

  const getTreeTool: RegisteredTool = {
    id: 'wiki.get_tree',
    label: 'Get Wiki Document Tree',
    description:
      'Return the hierarchical wiki document tree (titles, types, parent/child structure). Prefer this over list_documents when you need navigation context.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      snapshotId: z.string().optional().describe('Optional snapshot ID. Defaults to the latest snapshot.'),
    }),
    async execute(input) {
      const args = input.args as { snapshotId?: string };
      const scope = await resolveScope(input, args.snapshotId);
      if ('error' in scope) return toolError(scope.error, 'Wiki tree unavailable');
      if (!scope.snapshot) {
        return {
          result: { ok: true, tree: [], message: 'No wiki snapshot exists for this project yet.' },
          displaySummary: 'No wiki tree',
          artifacts: [],
        };
      }

      const docs = await wikiStore.getDocumentsBySnapshot(scope.snapshot.id);
      const tree = buildWikiDocumentTree(docs);
      return {
        result: {
          ok: true,
          snapshotId: scope.snapshot.id,
          snapshotStatus: scope.snapshot.status,
          tree,
          totalDocuments: docs.length,
        },
        displaySummary: `Wiki tree: ${docs.length} documents`,
        artifacts: [],
      };
    },
  };

  const listDocumentsTool: RegisteredTool = {
    id: 'wiki.list_documents',
    label: 'List Wiki Documents',
    description: 'List flat wiki document metadata for a snapshot. Use wiki.get_tree when hierarchy matters.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      snapshotId: z.string().optional().describe('Optional snapshot ID. Defaults to the latest snapshot.'),
    }),
    async execute(input) {
      const args = input.args as { snapshotId?: string };
      const scope = await resolveScope(input, args.snapshotId);
      if ('error' in scope) return toolError(scope.error, 'Wiki list unavailable');
      if (!scope.snapshot) {
        return {
          result: { documents: [], message: 'No wiki snapshot exists for this project yet.' },
          displaySummary: 'No documents',
          artifacts: [],
        };
      }

      const docs = await wikiStore.getDocumentsBySnapshot(scope.snapshot.id);
      const items = docs.map((d) => ({
        id: d.id,
        title: d.title,
        docType: d.docType,
        parentId: d.parentId,
        hasContent: d.contentMd.trim().length > 0,
        sortOrder: d.sortOrder,
        staleState: d.staleState,
        updatedAt: d.updatedAt,
      }));
      return {
        result: { snapshotId: scope.snapshot.id, documents: items },
        displaySummary: `Listed ${items.length} wiki documents`,
        artifacts: [],
      };
    },
  };

  const readDocumentTool: RegisteredTool = {
    id: 'wiki.read_document',
    label: 'Read Wiki Document',
    description: 'Read wiki document markdown content by document ID. Large documents are truncated.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documentId: z.string().min(1).describe('Wiki document ID to read.'),
      maxChars: z
        .number()
        .int()
        .positive()
        .max(MAX_READ_CHARS)
        .optional()
        .describe(`Maximum characters to return (default ${MAX_READ_CHARS}).`),
    }),
    async execute(input) {
      const args = input.args as { documentId: string; maxChars?: number };
      const doc = await wikiStore.getDocument(args.documentId);
      if (!doc) {
        return toolError('Document not found.', 'Document not found');
      }

      const maxChars = args.maxChars ?? MAX_READ_CHARS;
      const contentMd =
        doc.contentMd.length > maxChars
          ? `${doc.contentMd.slice(0, maxChars)}\n\n…(truncated, ${doc.contentMd.length} chars total)`
          : doc.contentMd;

      return {
        result: {
          ok: true,
          documentId: doc.id,
          snapshotId: doc.snapshotId,
          title: doc.title,
          docType: doc.docType,
          contentMd,
          references: doc.references,
          truncated: doc.contentMd.length > maxChars,
          totalChars: doc.contentMd.length,
        },
        displaySummary: `Read document "${doc.title}"`,
        artifacts: [],
      };
    },
  };

  const readSectionTool: RegisteredTool = {
    id: 'wiki.read_section',
    label: 'Read Wiki Section',
    description:
      'Read a single markdown section by heading (## level or deeper). Includes subsections until the next sibling heading. Saves tokens vs wiki.read_document.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documentId: z.string().min(1).describe('Wiki document ID.'),
      heading: z.string().min(1).describe('Section heading text (with or without leading #).'),
      maxChars: z
        .number()
        .int()
        .positive()
        .max(MAX_READ_CHARS)
        .optional()
        .describe(`Maximum characters to return (default ${DEFAULT_SECTION_CHARS}).`),
    }),
    async execute(input) {
      const args = input.args as { documentId: string; heading: string; maxChars?: number };
      const doc = await wikiStore.getDocument(args.documentId);
      if (!doc) {
        return toolError('Document not found.', 'Document not found');
      }

      const maxChars = args.maxChars ?? DEFAULT_SECTION_CHARS;
      const section = extractMarkdownSection(doc.contentMd, args.heading, { maxChars });
      if (!section.found) {
        return toolError(
          `Section "${args.heading}" not found in document "${doc.title}".`,
          'Section not found',
        );
      }

      return {
        result: {
          ok: true,
          documentId: doc.id,
          title: doc.title,
          heading: section.heading,
          level: section.level,
          contentMd: section.contentMd,
          startLine: section.startLine,
          endLine: section.endLine,
          truncated: section.contentMd.endsWith('…(truncated)'),
        },
        displaySummary: `Read section "${section.heading}" from "${doc.title}"`,
        artifacts: [],
      };
    },
  };

  const getReferencesTool: RegisteredTool = {
    id: 'wiki.get_references',
    label: 'Get Wiki Document References',
    description:
      'Return source file/symbol references attached to a wiki document. Use to jump from design docs to concrete code locations.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documentId: z.string().min(1).describe('Wiki document ID.'),
    }),
    async execute(input) {
      const args = input.args as { documentId: string };
      const doc = await wikiStore.getDocument(args.documentId);
      if (!doc) {
        return toolError('Document not found.', 'Document not found');
      }

      const byFile = new Map<string, typeof doc.references>();
      for (const ref of doc.references) {
        const group = byFile.get(ref.filePath) ?? [];
        group.push(ref);
        byFile.set(ref.filePath, group);
      }

      const fileGroups = [...byFile.entries()].map(([filePath, refs]) => ({
        filePath,
        refs: refs.map((r) => ({
          symbol: r.symbol ?? null,
          startLine: r.startLine ?? null,
          endLine: r.endLine ?? null,
          confidence: r.confidence ?? null,
        })),
      }));

      return {
        result: {
          ok: true,
          documentId: doc.id,
          title: doc.title,
          docType: doc.docType,
          references: doc.references,
          fileGroups,
          totalReferences: doc.references.length,
          uniqueFiles: fileGroups.length,
        },
        displaySummary: `${doc.references.length} reference(s) across ${fileGroups.length} file(s) for "${doc.title}"`,
        artifacts: [],
      };
    },
  };

  const searchContentTool: RegisteredTool = {
    id: 'wiki.search_content',
    label: 'Search Wiki Content (FTS)',
    description:
      'Full-text search across generated wiki documents using FTS5. Returns ranked snippets for fast recall — use before wiki.read_document when you do not know which doc contains the answer.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      query: z.string().min(1).describe('Search keyword or phrase (supports CJK).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .optional()
        .describe(`Max results (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`),
      documentId: z.string().optional().describe('Optional document ID to scope search to one document.'),
      snapshotId: z.string().optional().describe('Optional snapshot ID for title enrichment. Defaults to latest.'),
    }),
    async execute(input) {
      const args = input.args as {
        query: string;
        limit?: number;
        documentId?: string;
        snapshotId?: string;
      };
      const scope = await resolveScope(input, args.snapshotId);
      if ('error' in scope) return toolError(scope.error, 'Wiki search unavailable');

      const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
      const results = searchWikiDocuments({
        projectId: scope.projectId,
        query: args.query,
        limit,
        documentId: args.documentId,
      });

      const matches = await enrichWikiSearchMatches(results, {
        projectId: scope.projectId,
        snapshotId: scope.snapshot?.id ?? args.snapshotId,
      });

      return {
        result: {
          ok: true,
          query: args.query,
          matches,
          total: matches.length,
          scopedDocumentId: args.documentId ?? null,
        },
        displaySummary: `FTS: ${matches.length} match(es) for "${args.query}"`,
        artifacts: [],
      };
    },
  };

  const searchBatchTool: RegisteredTool = {
    id: 'wiki.search_batch',
    label: 'Batch Search Wiki Content (FTS)',
    description:
      'Run multiple FTS queries in one call and return ranked snippets per query. Reduces round-trips when exploring several keywords or concepts.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      queries: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_BATCH_QUERIES)
        .describe(`Search queries to run in parallel (max ${MAX_BATCH_QUERIES}).`),
      limitPerQuery: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .optional()
        .describe(`Max results per query (default ${DEFAULT_BATCH_LIMIT}).`),
      documentId: z.string().optional().describe('Optional document ID to scope all queries.'),
      snapshotId: z.string().optional().describe('Optional snapshot ID for title enrichment. Defaults to latest.'),
    }),
    async execute(input) {
      const args = input.args as {
        queries: string[];
        limitPerQuery?: number;
        documentId?: string;
        snapshotId?: string;
      };
      const scope = await resolveScope(input, args.snapshotId);
      if ('error' in scope) return toolError(scope.error, 'Wiki batch search unavailable');

      const limitPerQuery = args.limitPerQuery ?? DEFAULT_BATCH_LIMIT;
      const snapshotId = scope.snapshot?.id ?? args.snapshotId;
      const titleMap = await loadTitleMap(snapshotId, scope.snapshot?.id);

      const batchResults = await Promise.all(
        args.queries.map(async (query) => {
          const results = searchWikiDocuments({
            projectId: scope.projectId,
            query,
            limit: limitPerQuery,
            documentId: args.documentId,
          });
          const matches = results.map((r) => ({
            documentId: r.documentId,
            documentTitle: titleMap.get(r.documentId) ?? '',
            snippet: r.snippet,
            rank: r.rank,
          }));
          return { query, matches, total: matches.length };
        }),
      );

      const totalMatches = batchResults.reduce((sum, item) => sum + item.total, 0);
      return {
        result: {
          ok: true,
          results: batchResults,
          queryCount: args.queries.length,
          totalMatches,
          scopedDocumentId: args.documentId ?? null,
        },
        displaySummary: `FTS batch: ${totalMatches} match(es) across ${args.queries.length} queries`,
        artifacts: [],
      };
    },
  };

  return [
    getSnapshotTool,
    getTreeTool,
    listDocumentsTool,
    readDocumentTool,
    readSectionTool,
    getReferencesTool,
    searchContentTool,
    searchBatchTool,
  ];
}
