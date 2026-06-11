import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { CodeMapScanResult } from '../../contracts/code-map.js';
import { WIKI_DOC_TYPES } from './contracts.js';
import type {
  WikiOutlineEntry,
  WikiPlannerHandle,
  OutlineDraft,
  ValidationError,
  OutlineEditOp,
} from './contracts.js';
import { buildReadTools } from './read-tools.js';
import { derivePackages } from './package-baseline.js';

// ── Validation helpers ──────────────────────────────────────────────────────

function validateStructure(documents: WikiOutlineEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];

  if (documents.length === 0) {
    errors.push({ severity: 'error', field: 'documents', message: 'At least 1 document is required.' });
    return errors;
  }

  const idSet = new Set(documents.map(d => d.id));
  if (documents.length - idSet.size > 0) {
    errors.push({ severity: 'error', field: 'id', message: 'Duplicate document IDs detected.' });
  }

  for (const doc of documents) {
    if (doc.parentId && !idSet.has(doc.parentId)) {
      errors.push({ severity: 'error', field: 'parentId', message: `"${doc.title}" references unknown parentId "${doc.parentId}".` });
    }
  }

  const depthOf = (docId: string, visited = new Set<string>()): number => {
    if (visited.has(docId)) return Infinity;
    visited.add(docId);
    const doc = documents.find(d => d.id === docId);
    if (!doc?.parentId) return 0;
    return 1 + depthOf(doc.parentId, visited);
  };
  for (const doc of documents) {
    const depth = depthOf(doc.id);
    if (depth === Infinity) {
      errors.push({ severity: 'error', field: 'parentId', message: `Circular reference involving "${doc.title}".` });
    } else if (depth > 4) {
      errors.push({ severity: 'error', field: 'parentId', message: `"${doc.title}" exceeds max depth 4 (found ${depth}).` });
    }
  }

  const typeCount = (t: string) => documents.filter(d => d.docType === t).length;
  if (typeCount('landscape') < 1) {
    errors.push({ severity: 'error', field: 'docType', message: 'Need at least 1 landscape document.' });
  }
  if (typeCount('topology') < 1) {
    errors.push({ severity: 'error', field: 'docType', message: 'Need at least 1 topology document.' });
  }

  return errors;
}

function validateFilePaths(documents: WikiOutlineEntry[], validPaths: Set<string>): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const doc of documents) {
    const badFiles = doc.targetFiles.filter(p => !validPaths.has(p));
    if (badFiles.length > 0) {
      errors.push({
        severity: 'error',
        field: 'targetFiles',
        message: `"${doc.title}" has ${badFiles.length} non-existent targetFile(s): ${badFiles.slice(0, 3).join(', ')}.`,
      });
    }
  }
  return errors;
}

function fullValidation(
  documents: WikiOutlineEntry[],
  validPaths: Set<string>,
): ValidationError[] {
  return [
    ...validateStructure(documents),
    ...validateFilePaths(documents, validPaths),
  ];
}

function formatErrors(errors: ValidationError[]): string {
  return errors.map(e => `  - [${e.severity}] ${e.field}: ${e.message}`).join('\n');
}

// ── Tool factory ────────────────────────────────────────────────────────────

export function createPlannerTools(scan: CodeMapScanResult): WikiPlannerHandle {
  let draft: OutlineDraft | null = null;

  const readTools = buildReadTools(scan);
  const baseline = derivePackages(scan);
  const validPaths = new Set(scan.codeIndex.files.map(f => f.path));
  const pathToPkg = buildPathToPackage(baseline, scan.codeIndex.files);

  // ── Tool: create_outline_draft ──
  const createDraftTool: RegisteredTool = {
    id: 'wiki.create_outline_draft',
    label: 'Create Wiki Outline Draft',
    description: 'Create a draft document outline. Validates basic structure (duplicate IDs, circular refs, depth, min doc types) but does NOT check targetFiles paths. The draft is always saved; validation errors are returned for reference. Use wiki.edit_outline_draft to fix issues and wiki.submit_outline to lock the final outline.',
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
        targetFiles: z.array(z.string()).default([]).describe('File paths to read when writing this document.'),
        keyQuestions: z.array(z.string()).default([]).describe('Core questions this document must answer.'),
      })).min(1).describe('Planned documents with hierarchy.'),
    }),
    execute(input) {
      const args = input.args as { documents: WikiOutlineEntry[] };
      if (!args?.documents || !Array.isArray(args.documents)) {
        return { result: { ok: false, error: 'documents array is required.' }, displaySummary: 'Create draft failed.', artifacts: [] };
      }
      if (draft?.locked) {
        return { result: { ok: false, error: 'Outline is already locked (submitted). Cannot create a new draft.' }, displaySummary: 'Create draft failed — outline already submitted.', artifacts: [] };
      }

      const ve = validateStructure(args.documents);
      draft = { documents: args.documents, locked: false, validationErrors: ve };

      const summary = args.documents.map(d => {
        const indent = d.parentId ? '    ' : '  ';
        return `${indent}- ${d.docType}: "${d.title}" [${d.id}]`;
      }).join('\n');

      if (ve.length > 0) {
        return {
          result: { ok: true, validationErrors: ve.map(e => e.message), documentCount: args.documents.length },
          displaySummary: `Draft saved with ${ve.length} issue(s):\n${formatErrors(ve)}\n\n${summary}`,
          artifacts: [{ kind: 'decision', title: 'Wiki outline draft created (with issues)', summary: `${args.documents.length} documents drafted, ${ve.length} issues to fix.`, risk: 'low' }],
        };
      }

      return {
        result: { ok: true, validationErrors: [], documentCount: args.documents.length },
        displaySummary: `Draft saved successfully (no structural issues):\n${summary}`,
        artifacts: [{ kind: 'decision', title: 'Wiki outline draft created', summary: `${args.documents.length} documents drafted.`, risk: 'low' }],
      };
    },
  };

  // ── Tool: edit_outline_draft ──
  const editDraftTool: RegisteredTool = {
    id: 'wiki.edit_outline_draft',
    label: 'Edit Wiki Outline Draft',
    description: 'Edit the existing outline draft. Supports add, remove, update operations. Runs full validation (including targetFiles path checks) after each edit, but the draft is always updated. Check the returned validationErrors to see what still needs fixing.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      operations: z.array(z.union([
        z.object({ type: z.literal('add'), document: z.object({
          id: z.string().min(1),
          docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]),
          title: z.string().min(1),
          parentId: z.string().optional(),
          sortOrder: z.number().int().optional(),
          targetFiles: z.array(z.string()).default([]),
          keyQuestions: z.array(z.string()).default([]),
        }) }),
        z.object({ type: z.literal('remove'), docId: z.string() }),
        z.object({ type: z.literal('update'), docId: z.string(), changes: z.object({
          targetFiles: z.array(z.string()).optional(),
          keyQuestions: z.array(z.string()).optional(),
          title: z.string().optional(),
          parentId: z.string().optional(),
          sortOrder: z.number().int().optional(),
        }) }),
      ])).min(1),
    }),
    execute(input) {
      const args = input.args as { operations: OutlineEditOp[] };
      if (!draft) {
        return { result: { ok: false, error: 'No draft exists. Call wiki.create_outline_draft first.' }, displaySummary: 'Edit failed — no draft.', artifacts: [] };
      }
      if (draft.locked) {
        return { result: { ok: false, error: 'Outline is already locked (submitted). Cannot edit.' }, displaySummary: 'Edit failed — outline already submitted.', artifacts: [] };
      }

      const docs = [...draft.documents];

      for (const op of args.operations) {
        switch (op.type) {
          case 'add':
            if (!docs.find(d => d.id === op.document.id)) {
              docs.push(op.document);
            }
            break;
          case 'remove': {
            const idx = docs.findIndex(d => d.id === op.docId);
            if (idx >= 0) docs.splice(idx, 1);
            break;
          }
          case 'update': {
            const idx = docs.findIndex(d => d.id === op.docId);
            if (idx >= 0) {
              docs[idx] = { ...docs[idx], ...op.changes };
            }
            break;
          }
        }
      }

      const ve = fullValidation(docs, validPaths);
      draft = { documents: docs, locked: false, validationErrors: ve };

      const summary = docs.map(d => {
        const indent = d.parentId ? '    ' : '  ';
        return `${indent}- ${d.docType}: "${d.title}" [${d.id}]`;
      }).join('\n');

      if (ve.length > 0) {
        return {
          result: { ok: true, validationErrors: ve.map(e => e.message), documentCount: docs.length },
          displaySummary: `Draft updated with ${ve.length} issue(s):\n${formatErrors(ve)}\n\n${summary}`,
          artifacts: [{ kind: 'decision', title: 'Wiki outline draft edited (with issues)', summary: `${docs.length} documents, ${ve.length} issues remain.`, risk: 'low' }],
        };
      }

      return {
        result: { ok: true, validationErrors: [], documentCount: docs.length },
        displaySummary: `Draft updated — all checks passed:\n${summary}`,
        artifacts: [{ kind: 'decision', title: 'Wiki outline draft edited', summary: `${docs.length} documents, no issues.`, risk: 'low' }],
      };
    },
  };

  // ── Tool: submit_outline ──
  const submitOutlineTool: RegisteredTool = {
    id: 'wiki.submit_outline',
    label: 'Submit Wiki Outline',
    description: 'Lock the current outline draft after full validation (structure + file paths). If validation passes, the outline is locked and no further edits are allowed. If validation fails, the draft remains editable — fix via wiki.edit_outline_draft and retry.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({}),
    execute() {
      if (!draft) {
        return { result: { ok: false, error: 'No draft exists. Call wiki.create_outline_draft first.' }, displaySummary: 'Submit failed — no draft.', artifacts: [] };
      }
      if (draft.locked) {
        return { result: { ok: false, error: 'Outline is already submitted.' }, displaySummary: 'Outline already submitted.', artifacts: [] };
      }

      const ve = fullValidation(draft.documents, validPaths);
      if (ve.length > 0) {
        draft.validationErrors = ve;
        return {
          result: { ok: false, validationErrors: ve.map(e => e.message), documentCount: draft.documents.length },
          displaySummary: `Submit failed — ${ve.length} issue(s) remain:\n${formatErrors(ve)}\nUse wiki.edit_outline_draft to fix them.`,
          artifacts: [{ kind: 'decision', title: 'Wiki outline submit failed', summary: `${ve.length} issues remain.`, risk: 'low' }],
        };
      }

      draft.locked = true;
      draft.validationErrors = [];

      const summary = draft.documents.map(d => {
        const indent = d.parentId ? '    ' : '  ';
        return `${indent}- ${d.docType}: "${d.title}" [${d.id}]${d.parentId ? ` (child of ${d.parentId})` : ''}`;
      }).join('\n');
      return {
        result: { ok: true, count: draft.documents.length },
        displaySummary: `Outline accepted and locked: ${draft.documents.length} documents.\n${summary}`,
        artifacts: [{ kind: 'decision', title: 'Wiki outline submitted', summary: `${draft.documents.length} documents planned.`, risk: 'low' }],
      };
    },
  };

  return {
    tools: [...readTools, createDraftTool, editDraftTool, submitOutlineTool],
    getOutline: () => (draft?.locked ? draft.documents : null),
    getDraft: () => draft,
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
