import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { CodeMapScanResult } from '../../contracts/code-map.js';
import { buildAnalyzerGraph, computeBlastRadius } from '../../analyzer/graph.js';
import { buildTreeString } from './helpers.js';
import { PAGE_SIZE } from './contracts.js';

export function buildReadTools(scan: CodeMapScanResult): RegisteredTool[] {
  const graph = buildAnalyzerGraph(scan.codeIndex);

  const readCodeIndexTool: RegisteredTool = {
    id: 'wiki.read_code_index',
    label: 'Read Code Index',
    description: 'Read file list or symbol index from the code scan. Files include symbolCount and importCount. Symbols include degree (reference count) and call counts. Supports pagination.',
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
        const callCount = graph.callGraph.get(s.id)?.size ?? 0;
        const callerCount = graph.reverseCallGraph.get(s.id)?.size ?? 0;
        return { name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, path: file?.path ?? '', degree: coreSym?.degree ?? 0, callCount, callerCount };
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

  // PLACEHOLDER_READ_TOOLS_CONTINUE

  const readCallGraphTool: RegisteredTool = {
    id: 'wiki.read_call_graph',
    label: 'Read Call Graph',
    description: 'Query symbol-level call relationships. Find who calls a symbol (callers) or what it calls (callees). Useful for understanding module coupling and dependency chains.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      symbolName: z.string().min(1).describe('Symbol name to query (exact match on name, fallback to qualifiedName contains).'),
      direction: z.enum(['callers', 'callees', 'both']).describe('Query direction: who calls it, what it calls, or both.'),
      depth: z.number().int().min(1).max(2).optional().describe('Traversal depth (default 1, max 2).'),
    }),
    execute(input) {
      const args = input.args as { symbolName: string; direction: 'callers' | 'callees' | 'both'; depth?: number };
      const depth = args.depth ?? 1;

      const exact = scan.codeIndex.symbols.filter(s => s.name === args.symbolName);
      const matches = exact.length > 0
        ? exact
        : scan.codeIndex.symbols.filter(s => s.qualifiedName?.includes(args.symbolName));
      const targets = matches.slice(0, 5);

      if (targets.length === 0) {
        return { result: { ok: false, error: `No symbol matching "${args.symbolName}" found.` }, displaySummary: `No match for "${args.symbolName}".`, artifacts: [] };
      }

      const resolveSymbol = (id: string) => {
        const sym = scan.codeIndex.symbols.find(s => s.id === id);
        if (!sym) return null;
        const file = scan.codeIndex.files.find(f => f.id === sym.fileId);
        return { name: sym.name, qualifiedName: sym.qualifiedName, kind: sym.kind, path: file?.path ?? '' };
      };

      const collectChain = (startIds: string[], map: Map<string, Set<string>>, maxDepth: number) => {
        const result: Array<{ name: string; qualifiedName?: string; kind: string; path: string; depth: number }> = [];
        const visited = new Set(startIds);
        let queue = startIds.map(id => ({ id, d: 0 }));
        while (queue.length > 0) {
          const next: typeof queue = [];
          for (const { id, d } of queue) {
            if (d >= maxDepth) continue;
            const neighbors = map.get(id);
            if (!neighbors) continue;
            for (const nId of neighbors) {
              if (visited.has(nId)) continue;
              visited.add(nId);
              const sym = resolveSymbol(nId);
              if (sym) result.push({ ...sym, depth: d + 1 });
              next.push({ id: nId, d: d + 1 });
            }
          }
          queue = next;
        }
        return result.slice(0, 30);
      };

      const results = targets.map(t => {
        const info = resolveSymbol(t.id)!;
        const callers = (args.direction === 'callers' || args.direction === 'both')
          ? collectChain([t.id], graph.reverseCallGraph, depth) : undefined;
        const callees = (args.direction === 'callees' || args.direction === 'both')
          ? collectChain([t.id], graph.callGraph, depth) : undefined;
        return { target: info, callers, callees };
      });

      return {
        result: { ok: true, results },
        displaySummary: `Call graph for "${args.symbolName}": ${targets.length} match(es).`,
        artifacts: [],
      };
    },
  };

  const impactAnalysisTool: RegisteredTool = {
    id: 'wiki.impact_analysis',
    label: 'Impact Analysis',
    description: 'Analyze the blast radius of a symbol or file change. Shows which symbols and files would be affected transitively through the call graph.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      target: z.string().min(1).describe('Symbol name or file path to analyze.'),
      targetType: z.enum(['symbol', 'file']).describe('Whether target is a symbol name or file path.'),
    }),
    execute(input) {
      const args = input.args as { target: string; targetType: 'symbol' | 'file' };
      let symbolIds: string[] = [];

      if (args.targetType === 'file') {
        const file = scan.codeIndex.files.find(f => f.path === args.target || f.path.endsWith(args.target));
        if (!file) {
          return { result: { ok: false, error: `File "${args.target}" not found.` }, displaySummary: `No file matching "${args.target}".`, artifacts: [] };
        }
        symbolIds = scan.codeIndex.symbols.filter(s => s.fileId === file.id).map(s => s.id);
      } else {
        const exact = scan.codeIndex.symbols.filter(s => s.name === args.target);
        const matches = exact.length > 0 ? exact : scan.codeIndex.symbols.filter(s => s.qualifiedName?.includes(args.target));
        symbolIds = matches.slice(0, 5).map(s => s.id);
      }

      if (symbolIds.length === 0) {
        return { result: { ok: false, error: `No symbols found for "${args.target}".` }, displaySummary: `No match for "${args.target}".`, artifacts: [] };
      }

      const affected = computeBlastRadius(symbolIds, graph.reverseCallGraph);
      const affectedSymbols = [...affected].map(id => {
        const sym = scan.codeIndex.symbols.find(s => s.id === id);
        if (!sym) return null;
        const file = scan.codeIndex.files.find(f => f.id === sym.fileId);
        return { name: sym.name, qualifiedName: sym.qualifiedName, kind: sym.kind, path: file?.path ?? '' };
      }).filter(Boolean);

      const affectedFiles = [...new Set(affectedSymbols.map(s => s!.path))];

      return {
        result: { ok: true, target: args.target, targetType: args.targetType, sourceSymbolCount: symbolIds.length, affectedSymbols, affectedFiles },
        displaySummary: `Impact of "${args.target}": ${affectedSymbols.length} affected symbols across ${affectedFiles.length} files.`,
        artifacts: [],
      };
    },
  };

  return [readCodeIndexTool, readGraphTool, readModulesTool, readTreeTool, readCallGraphTool, impactAnalysisTool];
}
