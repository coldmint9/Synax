import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { CodeMapScanResult } from '../../contracts/code-map.js';
import { WIKI_DOC_TYPES, MIN_PACKAGE_FILES, COVERAGE_MIN, FILE_SPLIT, SYM_SPLIT } from './contracts.js';
import type { WikiOutlineEntry, WikiPlannerHandle } from './contracts.js';
import { buildReadTools } from './read-tools.js';
import { derivePackages, filterBaselineForPrompt } from './package-baseline.js';

export function createPlannerTools(scan: CodeMapScanResult): WikiPlannerHandle {
  let submittedOutline: WikiOutlineEntry[] | null = null;

  const readTools = buildReadTools(scan);
  const baseline = derivePackages(scan);
  const validPaths = new Set(scan.codeIndex.files.map(f => f.path));
  const pathToPkg = buildPathToPackage(baseline, scan.codeIndex.files);

  const submitOutlineTool: RegisteredTool = {
    id: 'wiki.submit_outline',
    label: 'Submit Wiki Outline',
    description: 'Submit a flat document outline grouped by type (landscape, topology, module, flow, data). Must include: 1+ landscape, 1+ topology, modules for all core packages. Total >= 5. targetFiles must be real file paths from the code index.',
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
        else if (depth > 4) errors.push(`"${doc.title}" exceeds max depth 4.`);
      }

      const typeCount = (t: string) => args.documents.filter(d => d.docType === t).length;
      if (typeCount('landscape') < 1) errors.push('Need at least 1 landscape document.');
      if (typeCount('topology') < 1) errors.push('Need at least 1 topology document.');

      // ── Gate 1: targetFiles must be real paths ──
      for (const doc of args.documents) {
        const badFiles = doc.targetFiles.filter(p => !validPaths.has(p));
        if (badFiles.length > 0) {
          errors.push(`"${doc.title}" has ${badFiles.length} non-existent targetFile(s): ${badFiles.slice(0, 3).join(', ')}.`);
        }
      }

      // ── Gate 2: package coverage (against prompt-facing baseline) ──
      const promptBaseline = filterBaselineForPrompt(baseline);
      const coverable = promptBaseline.filter(p => p.fileCount >= MIN_PACKAGE_FILES);
      const covered = new Map<string, string>();
      for (const doc of args.documents) {
        for (const p of doc.targetFiles) {
          const pkg = pathToPkg.get(p);
          if (pkg && !covered.has(pkg.id)) covered.set(pkg.id, doc.title);
        }
      }
      const uncovered = coverable.filter(p => !covered.has(p.id));
      if (coverable.length > 0) {
        const covRatio = covered.size / coverable.length;
        if (covRatio < COVERAGE_MIN) {
          const missing = uncovered.slice(0, 5).map(p => {
            const samples = scan.codeIndex.files
              .filter(f => p.fileIds.includes(f.id))
              .slice(0, 3)
              .map(f => f.path);
            return `  - ${p.label} (${p.fileCount} files) → e.g. ${samples.join(', ')}`;
          }).join('\n');
          errors.push(`Coverage ${(covRatio * 100).toFixed(0)}% (${covered.size}/${coverable.length} packages). Uncovered:\n${missing}`);
        }
      }

      // ── Gate 3: size-driven split ──
      // Grade only the packages the model was actually shown (promptBaseline), and use the
      // exact same [SPLIT] criterion the prompt displays (AND, not OR). Otherwise the model
      // gets rejected on ancestor containers (e.g. web/src) that filterBaselineForPrompt pruned,
      // or on packages the prompt never marked as needing a split — an unsatisfiable contract.
      for (const p of promptBaseline) {
        if (!(p.fileCount >= FILE_SPLIT && p.symbolCount >= SYM_SPLIT)) continue;
        const coveringDocs = args.documents.filter(d =>
          d.targetFiles.some(tf => {
            const pkg = pathToPkg.get(tf);
            return pkg?.id === p.id;
          }),
        );
        const hasChildren = args.documents.some(d => d.parentId && coveringDocs.some(c => c.id === d.parentId));
        if (coveringDocs.length === 1 && !hasChildren) {
          const hubs = p.hubSymbols.slice(0, 3).map(h => h.name).join(', ');
          errors.push(`${p.label} (${p.fileCount} files, ${p.symbolCount} syms) needs >1 doc. Split hint: ${hubs || 'submodules'}`);
        }
      }

      if (errors.length > 0) {
        return { result: { ok: false, error: errors.join(' ') }, displaySummary: `Outline rejected:\n${errors.map(e => '  - ' + e).join('\n')}`, artifacts: [] };
      }

      submittedOutline = args.documents;
      const summary = args.documents.map(d => {
        const indent = d.parentId ? '    ' : '  ';
        return `${indent}- ${d.docType}: "${d.title}" [${d.id}]${d.parentId ? ` (child of ${d.parentId})` : ''}`;
      }).join('\n');
      return {
        result: { ok: true, count: args.documents.length },
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

function buildPathToPackage(
  baseline: ReturnType<typeof derivePackages>,
  files: { id: string; path: string }[],
): Map<string, { id: string; label: string }> {
  const map = new Map<string, { id: string; label: string }>();
  const fileToPkg = new Map<string, string>();
  for (const pkg of baseline) {
    for (const fid of pkg.fileIds) {
      fileToPkg.set(fid, pkg.id);
    }
  }
  for (const f of files) {
    const pkgId = fileToPkg.get(f.id);
    if (pkgId) {
      const pkg = baseline.find(p => p.id === pkgId);
      if (pkg) map.set(f.path, { id: pkg.id, label: pkg.label });
    }
  }
  return map;
}
