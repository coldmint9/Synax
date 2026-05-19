import { z } from 'zod';
import type { RegisteredTool } from '../agent-runtime/contracts.js';
import type { CodeMapScanResult } from '../contracts/code-map.js';
import type { WikiDocType, WikiBlockType, WikiBlockContentFormat } from './contracts.js';

const WIKI_DOC_TYPES: WikiDocType[] = [
  'overview', 'architecture', 'tech_stack', 'module_design',
  'data_model', 'api', 'flow', 'risk', 'decision',
  'directory_tree', 'module_spec',
];

const WIKI_BLOCK_TYPES: WikiBlockType[] = [
  'heading', 'paragraph', 'list', 'table',
  'diagram', 'code_ref', 'decision', 'risk', 'task',
];

const MIN_CONTENT_LENGTH = 100;
const MIN_BLOCKS = 3;

export interface WikiDocumentDraft {
  title: string;
  docType: WikiDocType;
  sortOrder?: number;
  parentPlanId?: string;
  blocks: Array<{
    blockType: WikiBlockType;
    content: unknown;
    contentFormat?: WikiBlockContentFormat;
    sourceHints?: string[];
    confidence?: number;
  }>;
}

export interface WikiOutlineEntry {
  id: string;
  docType: WikiDocType;
  title: string;
  parentId?: string;
  sortOrder?: number;
  targetFiles: string[];
  keyQuestions: string[];
}

export interface WikiPlanEntry {
  id: string;
  docType: WikiDocType;
  title: string;
  parentId?: string;
  targetFiles: string[];
  keyQuestions: string[];
}

export interface WikiPlannerHandle {
  tools: RegisteredTool[];
  getOutline(): WikiOutlineEntry[] | null;
}

export interface WikiWriterHandle {
  tools: RegisteredTool[];
  getCommittedDocuments(): WikiDocumentDraft[];
}

const PAGE_SIZE = 40;

function buildTreeString(files: string[], root: string, maxDepth: number): string {
  const tree: Record<string, { files: string[]; dirs: Set<string> }> = {};
  for (const filePath of files) {
    const rel = root ? filePath.slice(root.length).replace(/^\//, '') : filePath;
    const parts = rel.split('/');
    for (let depth = 0; depth < Math.min(parts.length, maxDepth); depth++) {
      const dir = parts.slice(0, depth + 1).join('/');
      const parent = depth === 0 ? '.' : parts.slice(0, depth).join('/');
      if (!tree[parent]) tree[parent] = { files: [], dirs: new Set() };
      if (depth + 1 < parts.length) {
        tree[parent].dirs.add(dir);
      } else {
        tree[parent].files.push(parts[parts.length - 1]);
      }
    }
  }
  const lines: string[] = [];
  const render = (dir: string, prefix: string, depth: number) => {
    const node = tree[dir];
    if (!node) return;
    const entries: Array<{ name: string; isDir: boolean }> = [];
    for (const d of node.dirs) entries.push({ name: d.split('/').pop()!, isDir: true });
    for (const f of node.files) entries.push({ name: f, isDir: false });
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    for (let i = 0; i < entries.length; i++) {
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const entry = entries[i];
      if (entry.isDir) {
        const fullDir = dir === '.' ? entry.name : `${dir}/${entry.name}`;
        const childCount = files.filter(f => {
          const r = root ? f.slice(root.length).replace(/^\//, '') : f;
          return r.startsWith(fullDir + '/') || r === fullDir;
        }).length;
        lines.push(`${prefix}${connector}${entry.name}/ (${childCount} files)`);
        if (depth + 1 < maxDepth) {
          render(fullDir, prefix + (isLast ? '    ' : '│   '), depth + 1);
        }
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  };
  const rootLabel = root || '.';
  lines.push(`${rootLabel}/`);
  render('.', '', 0);
  return lines.join('\n');
}

export function createPlannerTools(scan: CodeMapScanResult): WikiPlannerHandle {
  let submittedOutline: WikiOutlineEntry[] | null = null;

  const readTools = buildReadTools(scan);

  const submitOutlineTool: RegisteredTool = {
    id: 'wiki.submit_outline',
    label: 'Submit Wiki Outline',
    description: 'Submit a hierarchical document outline. Each entry has a unique id and optional parentId for nesting. Must include: 1+ directory_tree, 1+ overview, 3+ module_spec. Total >= 8. Max depth 3. targetFiles must be real file paths from the code index.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documents: z.array(z.object({
        id: z.string().min(1).describe('Unique local ID (e.g. "root-overview", "mod-auth").'),
        docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]).describe('Document type.'),
        title: z.string().min(1).describe('Document title.'),
        parentId: z.string().optional().describe('ID of parent document. Omit for root-level.'),
        sortOrder: z.number().int().optional().describe('Display order among siblings (default 0).'),
        targetFiles: z.array(z.string()).describe('File paths to read when writing this document.'),
        keyQuestions: z.array(z.string()).min(1).describe('Core questions this document must answer.'),
      })).min(1).describe('Planned documents with hierarchy.'),
    }),
    execute(input) {
      const args = input.args as { documents: WikiOutlineEntry[] };
      const errors: string[] = [];
      if (!args?.documents || !Array.isArray(args.documents)) {
        return { result: { ok: false, error: 'documents array is required.' }, displaySummary: 'Outline rejected.', artifacts: [] };
      }

      const idSet = new Set(args.documents.map(d => d.id));
      if (args.documents.length - idSet.size > 0) errors.push('Duplicate document IDs detected.');

      for (const doc of args.documents) {
        if (doc.parentId && !idSet.has(doc.parentId)) {
          errors.push(`"${doc.title}" references unknown parentId "${doc.parentId}".`);
        }
      }

      const depthOf = (docId: string, visited = new Set<string>()): number => {
        if (visited.has(docId)) return Infinity;
        visited.add(docId);
        const doc = args.documents.find(d => d.id === docId);
        if (!doc?.parentId) return 0;
        return 1 + depthOf(doc.parentId, visited);
      };
      for (const doc of args.documents) {
        const depth = depthOf(doc.id);
        if (depth === Infinity) errors.push(`Circular reference involving "${doc.title}".`);
        else if (depth > 3) errors.push(`"${doc.title}" exceeds max depth 3.`);
      }

      const typeCount = (t: string) => args.documents.filter(d => d.docType === t).length;
      if (typeCount('directory_tree') < 1) errors.push('Need at least 1 directory_tree.');
      if (typeCount('overview') < 1) errors.push('Need at least 1 overview.');
      if (typeCount('module_spec') < 3) errors.push(`Need at least 3 module_spec (found ${typeCount('module_spec')}).`);
      if (args.documents.length < 8) errors.push(`Need at least 8 documents (found ${args.documents.length}).`);

      if (errors.length > 0) {
        return { result: { ok: false, error: errors.join(' ') }, displaySummary: `Outline rejected:\n${errors.map(e => '  - ' + e).join('\n')}`, artifacts: [] };
      }

      submittedOutline = args.documents;
      const summary = args.documents.map(d => {
        const indent = d.parentId ? '    ' : '  ';
        return `${indent}- ${d.docType}: "${d.title}" [${d.id}]${d.parentId ? ` (child of ${d.parentId})` : ''}`;
      }).join('\n');
      return {
        result: { ok: true, count: args.documents.length, documents: args.documents },
        displaySummary: `Outline accepted: ${args.documents.length} documents.\n${summary}`,
        artifacts: [{ kind: 'decision', title: 'Wiki outline submitted', summary: `${args.documents.length} documents planned.`, risk: 'low' }],
      };
    },
  };

  return {
    tools: [...readTools, submitOutlineTool],
    getOutline: () => submittedOutline,
  };
}
function buildReadTools(scan: CodeMapScanResult): RegisteredTool[] {
  const readCodeIndexTool: RegisteredTool = {
    id: 'wiki.read_code_index',
    label: 'Read Code Index',
    description: 'Read file list or symbol index from the code scan. Files include symbolCount and importCount. Symbols include degree (reference count). Supports pagination.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      kind: z.enum(['files', 'symbols']).describe('Which index to read.'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0).'),
    }),
    execute(input) {
      const args = input.args as { kind: 'files' | 'symbols'; offset?: number };
      const offset = args.offset ?? 0;
      if (args.kind === 'files') {
        const slice = scan.codeIndex.files.slice(offset, offset + PAGE_SIZE);
        const items = slice.map(f => ({
          path: f.path,
          language: f.language,
          symbolCount: scan.codeIndex.symbols.filter(s => s.fileId === f.id).length,
          importCount: scan.codeIndex.imports.filter(i => i.sourceFileId === f.id).length,
        }));
        return {
          result: { items, total: scan.codeIndex.files.length, offset, hasMore: offset + PAGE_SIZE < scan.codeIndex.files.length },
          displaySummary: `Returned ${items.length} files (offset ${offset}, total ${scan.codeIndex.files.length}).`,
          artifacts: [],
        };
      }
      const slice = scan.codeIndex.symbols.slice(offset, offset + PAGE_SIZE);
      const items = slice.map(s => {
        const file = scan.codeIndex.files.find(f => f.id === s.fileId);
        const coreSym = scan.moduleMap?.coreSymbols.find(c => c.id === s.id);
        return { name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, path: file?.path ?? '', degree: coreSym?.degree ?? 0 };
      });
      return {
        result: { items, total: scan.codeIndex.symbols.length, offset, hasMore: offset + PAGE_SIZE < scan.codeIndex.symbols.length },
        displaySummary: `Returned ${items.length} symbols (offset ${offset}, total ${scan.codeIndex.symbols.length}).`,
        artifacts: [],
      };
    },
  };

  const readGraphTool: RegisteredTool = {
    id: 'wiki.read_graph',
    label: 'Read Semantic Graph',
    description: 'Read semantic graph nodes or community clusters. Communities show how files/symbols are grouped by functionality.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      section: z.enum(['nodes', 'communities']).describe('Which section to read.'),
    }),
    execute(input) {
      const args = input.args as { section: 'nodes' | 'communities' };
      if (args.section === 'nodes') {
        const nodes = scan.semanticGraph.nodes.slice(0, 60);
        return {
          result: { nodes, total: scan.semanticGraph.nodes.length },
          displaySummary: `Returned ${nodes.length} semantic nodes (total ${scan.semanticGraph.nodes.length}).`,
          artifacts: [],
        };
      }
      const communities = scan.communities ?? [];
      return { result: { communities }, displaySummary: `Returned ${communities.length} communities.`, artifacts: [] };
    },
  };
  // PLACEHOLDER_READTOOLS_CONTINUE
  const readModulesTool: RegisteredTool = {
    id: 'wiki.read_modules',
    label: 'Read Module Structure',
    description: 'Read top-level module structure, language breakdown, entry files, and core symbols ranked by importance.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({}),
    execute() {
      const moduleMap = scan.moduleMap ?? { topDirs: [], languages: [], entryFiles: [], coreSymbols: [], dependencies: [] };
      return {
        result: moduleMap,
        displaySummary: `Returned module map: ${moduleMap.topDirs.length} dirs, ${moduleMap.languages.length} languages, ${moduleMap.coreSymbols.length} core symbols.`,
        artifacts: [],
      };
    },
  };

  const readTreeTool: RegisteredTool = {
    id: 'wiki.read_tree',
    label: 'Read Directory Tree',
    description: 'Read the project directory tree structure. Returns a formatted tree with file counts per directory.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      path: z.string().optional().describe('Subdirectory to read (default: root).'),
      depth: z.number().int().min(1).max(5).optional().describe('Max depth (default: 3).'),
    }),
    execute(input) {
      const args = input.args as { path?: string; depth?: number };
      const root = args.path ?? '';
      const maxDepth = args.depth ?? 3;
      const files = scan.codeIndex.files
        .map(f => f.path)
        .filter(p => root ? p.startsWith(root) : true);
      const tree = buildTreeString(files, root, maxDepth);
      return {
        result: { tree, fileCount: files.length },
        displaySummary: `Directory tree: ${files.length} files.`,
        artifacts: [],
      };
    },
  };

  return [readCodeIndexTool, readGraphTool, readModulesTool, readTreeTool];
}

function buildCheckMermaidTool(): RegisteredTool {
  return {
    id: 'wiki.check_mermaid',
    label: 'Check Mermaid Syntax',
    description: 'Validate mermaid diagram syntax before committing. Returns parse errors so you can fix them.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      code: z.string().min(1).describe('Raw mermaid diagram code (without ```mermaid fences).'),
    }),
    async execute(input) {
      const args = input.args as { code: string };
      const code = args.code.trim();
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false });
        const result = await mermaid.parse(code);
        return {
          result: { ok: true, diagramType: result?.diagramType ?? 'unknown' },
          displaySummary: `Mermaid syntax valid (${result?.diagramType ?? 'unknown'}).`,
          artifacts: [],
        };
      } catch (e: any) {
        const message = e?.message ?? String(e);
        return {
          result: { ok: false, error: message },
          displaySummary: `Mermaid syntax error:\n${message}`,
          artifacts: [],
          followUpHints: ['Fix the syntax error and re-check before committing.'],
        };
      }
    },
  };
}

function buildCommitDocumentTool(committedDocuments: WikiDocumentDraft[], outline: WikiOutlineEntry[] | null): RegisteredTool {
  return {
    id: 'wiki.commit_document',
    label: 'Commit Wiki Document',
    description: 'Submit a completed wiki document. Pass parentPlanId to nest under a parent. Quality gates: min 3 blocks, paragraph/list/table content >= 100 chars, non-heading blocks must have sourceHints.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      title: z.string().min(1).describe('Document title.'),
      docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]).describe('Document type.'),
      parentPlanId: z.string().optional().describe('Plan ID of the parent document from the outline. Omit for root-level.'),
      sortOrder: z.number().int().optional().describe('Display order among siblings.'),
      blocks: z.array(z.object({
        blockType: z.enum(WIKI_BLOCK_TYPES as [string, ...string[]]),
        content: z.string().describe('Block content as a markdown string.'),
        contentFormat: z.enum(['rich_text_json', 'markdown_fragment', 'diagram_json']).optional(),
        sourceHints: z.array(z.string()).optional(),
        confidence: z.number().min(0).max(1).optional(),
      })).min(1).describe('Document blocks.'),
    }),
    execute(input) {
      const args = input.args as WikiDocumentDraft & { parentPlanId?: string; blocks: Array<{ blockType: WikiBlockType; content: string; contentFormat?: WikiBlockContentFormat; sourceHints?: string[]; confidence?: number }> };
      if (!args?.blocks || !Array.isArray(args.blocks)) {
        return { result: { ok: false, errors: ['blocks array is required.'], message: 'Document rejected.' }, displaySummary: 'Document rejected.', artifacts: [] };
      }
      if (!args?.title || !args?.docType) {
        return { result: { ok: false, errors: ['title and docType are required.'], message: 'Document rejected.' }, displaySummary: 'Document rejected.', artifacts: [] };
      }

      const errors: string[] = [];
      if (args.parentPlanId && outline) {
        if (!outline.find(p => p.id === args.parentPlanId)) {
          errors.push(`parentPlanId "${args.parentPlanId}" not found in outline.`);
        }
      }
      if (args.blocks.length < MIN_BLOCKS) {
        errors.push(`Too few blocks: ${args.blocks.length} (minimum ${MIN_BLOCKS}).`);
      }
      for (let i = 0; i < args.blocks.length; i++) {
        const block = args.blocks[i];
        const needsContent = ['paragraph', 'list', 'table', 'code_ref'].includes(block.blockType);
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        if (needsContent && content.length < MIN_CONTENT_LENGTH) {
          errors.push(`Block ${i + 1} (${block.blockType}) too short: ${content.length} chars (min ${MIN_CONTENT_LENGTH}).`);
        }
        const needsHints = block.blockType !== 'heading' && block.blockType !== 'task';
        if (needsHints && (!block.sourceHints || block.sourceHints.length === 0)) {
          errors.push(`Block ${i + 1} (${block.blockType}) missing sourceHints.`);
        }
      }

      if (errors.length > 0) {
        return {
          result: { ok: false, errors, message: 'Document rejected. Fix and resubmit.' },
          displaySummary: `"${args.title}" rejected: ${errors.length} issue(s).\n${errors.map(e => '  - ' + e).join('\n')}`,
          artifacts: [],
        };
      }

      committedDocuments.push(args);
      return {
        result: { ok: true, index: committedDocuments.length - 1, title: args.title, docType: args.docType, blockCount: args.blocks.length },
        displaySummary: `Committed "${args.title}" (${args.docType}, ${args.blocks.length} blocks). Total: ${committedDocuments.length}.`,
        artifacts: [{ kind: 'evidence', title: `Wiki: ${args.title}`, summary: `Generated ${args.docType} with ${args.blocks.length} blocks.`, risk: 'low' }],
      };
    },
  };
}

export function createWriterTools(scan: CodeMapScanResult, outline: WikiOutlineEntry[]): WikiWriterHandle {
  const committedDocuments: WikiDocumentDraft[] = [];
  const readTools = buildReadTools(scan);
  const commitTool = buildCommitDocumentTool(committedDocuments, outline);
  const checkMermaid = buildCheckMermaidTool();

  return {
    tools: [...readTools, checkMermaid, commitTool],
    getCommittedDocuments: () => committedDocuments,
  };
}

export interface WikiToolsHandle {
  tools: RegisteredTool[];
  getCommittedDocuments(): WikiDocumentDraft[];
  getPlan(): WikiPlanEntry[] | null;
  getPlanIdMapping(): Map<string, string>;
}

/** Legacy single-phase tool set (backward compat) */
export function createWikiTools(scan: CodeMapScanResult): WikiToolsHandle {
  const committedDocuments: WikiDocumentDraft[] = [];
  let submittedPlan: WikiPlanEntry[] | null = null;
  const planIdToDocId = new Map<string, string>();

  const readTools = buildReadTools(scan);
  const checkMermaid = buildCheckMermaidTool();
  const commitTool = buildCommitDocumentTool(committedDocuments, null);

  const submitPlanTool: RegisteredTool = {
    id: 'wiki.submit_plan',
    label: 'Submit Wiki Plan',
    description: 'Submit a hierarchical document plan. Must include: 1+ directory_tree, 1+ overview, 3+ module_spec. Total >= 8. Max depth 3.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documents: z.array(z.object({
        id: z.string().min(1),
        docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]),
        title: z.string().min(1),
        parentId: z.string().optional(),
        targetFiles: z.array(z.string()),
        keyQuestions: z.array(z.string()).min(1),
      })).min(1),
    }),
    execute(input) {
      const args = input.args as { documents: WikiPlanEntry[] };
      if (!args?.documents || !Array.isArray(args.documents)) {
        return { result: { ok: false, error: 'documents array required.' }, displaySummary: 'Plan rejected.', artifacts: [] };
      }
      submittedPlan = args.documents;
      return {
        result: { ok: true, message: `Plan accepted: ${args.documents.length} documents.`, documents: args.documents },
        displaySummary: `Plan accepted: ${args.documents.length} documents.`,
        artifacts: [],
      };
    },
  };

  return {
    tools: [...readTools, checkMermaid, submitPlanTool, commitTool],
    getCommittedDocuments: () => committedDocuments,
    getPlan: () => submittedPlan,
    getPlanIdMapping: () => planIdToDocId,
  };
}
