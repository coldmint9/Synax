import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { CodeMapScanResult } from '../../contracts/code-map.js';
import { WIKI_DOC_TYPES } from './contracts.js';
import type {
  WikiOutlineEntry,
  WikiPlannerHandle,
  OutlineDraft,
  OutlineEditOp,
} from './contracts.js';
import { buildReadTools } from './read-tools.js';
import { derivePackages, filterBaselineForPrompt } from './package-baseline.js';
import {
  fullValidation,
  formatErrors,
  blockingErrors,
} from './outline-validation.js';
import { sanitizeOutline } from './outline-sanitize.js';
import { isSectionEntry } from './outline-node.js';

const outlineEntrySchema = z.object({
  id: z.string().min(1).describe('Unique local ID (e.g. "sec-modules", "mod-auth").'),
  nodeKind: z.enum(['section', 'document']).default('document').describe('section = fold-only folder (no content); document = writable page.'),
  docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]).optional().describe('Required for nodeKind=document.'),
  title: z.string().min(1).describe('Title shown in the tree.'),
  parentId: z.string().optional().describe('ID of parent node. Omit for root-level.'),
  sortOrder: z.number().int().optional().describe('Display order among siblings (default 0).'),
  targetFiles: z.array(z.string()).default([]).describe('Writable documents only — real file paths.'),
  keyQuestions: z.array(z.string()).default([]).describe('Writable documents only — at least 2 specific questions.'),
});

function formatOutlineSummary(docs: WikiOutlineEntry[]): string {
  return docs.map(d => {
    const indent = d.parentId ? '    ' : '  ';
    const label = isSectionEntry(d) ? `[section] "${d.title}"` : `${d.docType}: "${d.title}"`;
    return `${indent}- ${label} [${d.id}]`;
  }).join('\n');
}

// ── Tool factory ────────────────────────────────────────────────────────────

export function createPlannerTools(scan: CodeMapScanResult): WikiPlannerHandle {
  let draft: OutlineDraft | null = null;

  const allReadTools = buildReadTools(scan);
  const readTreeTool = allReadTools.find(t => t.id === 'wiki.read_tree')!;
  const baseline = derivePackages(scan);
  const corePackages = filterBaselineForPrompt(baseline);
  const validPaths = new Set(scan.codeIndex.files.map(f => f.path));
  const pathToPkg = buildPathToPackage(baseline, scan.codeIndex.files);

  // ── Tool: create_outline_draft ──
  const createDraftTool: RegisteredTool = {
    id: 'wiki.create_outline_draft',
    label: 'Create Wiki Outline Draft',
    description: 'Create a draft outline in one call. Use nodeKind=section for folder headers (title + parentId only, no content). Use nodeKind=document for writable pages (docType, targetFiles, keyQuestions). Sections organize the tree; only documents are written.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documents: z.array(outlineEntrySchema).min(1).describe('Full outline: section nodes for folders + document nodes for pages.'),
    }),
    execute(input) {
      const args = input.args as { documents: WikiOutlineEntry[] };
      if (!args?.documents || !Array.isArray(args.documents)) {
        return { result: { ok: false, error: 'documents array is required.' }, displaySummary: 'Create draft failed.', artifacts: [] };
      }
      if (draft?.locked) {
        return { result: { ok: false, error: 'Outline is already locked (submitted). Cannot create a new draft.' }, displaySummary: 'Create draft failed — outline already submitted.', artifacts: [] };
      }

      const sanitized = sanitizeOutline(args.documents, validPaths);
      const ve = fullValidation(sanitized, validPaths, { corePackages, strictQuality: true });
      const blocking = blockingErrors(ve);
      draft = { documents: sanitized, locked: false, validationErrors: ve };

      const summary = formatOutlineSummary(sanitized);

      if (blocking.length > 0) {
        return {
          result: { ok: true, validationErrors: blocking.map(e => e.message), documentCount: sanitized.length },
          displaySummary: `Draft saved with ${blocking.length} blocking issue(s):\n${formatErrors(blocking)}\n\n${summary}`,
          artifacts: [{ kind: 'decision', title: 'Wiki outline draft created (with issues)', summary: `${sanitized.length} nodes drafted, ${blocking.length} issues to fix.`, risk: 'low' }],
        };
      }

      return {
        result: { ok: true, validationErrors: ve.filter(e => e.severity === 'warning').map(e => e.message), documentCount: sanitized.length },
        displaySummary: `Draft saved successfully (no blocking issues):\n${summary}`,
        artifacts: [{ kind: 'decision', title: 'Wiki outline draft created', summary: `${sanitized.length} outline nodes drafted.`, risk: 'low' }],
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
        z.object({ type: z.literal('add'), document: outlineEntrySchema }),
        z.object({ type: z.literal('remove'), docId: z.string() }),
        z.object({ type: z.literal('update'), docId: z.string(), changes: z.object({
          targetFiles: z.array(z.string()).optional(),
          keyQuestions: z.array(z.string()).optional(),
          title: z.string().optional(),
          parentId: z.string().optional(),
          sortOrder: z.number().int().optional(),
          nodeKind: z.enum(['section', 'document']).optional(),
          docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]).optional(),
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

      const sanitized = sanitizeOutline(docs, validPaths);
      const ve = fullValidation(sanitized, validPaths, { corePackages, strictQuality: true });
      const blocking = blockingErrors(ve);
      draft = { documents: sanitized, locked: false, validationErrors: ve };

      const summary = formatOutlineSummary(sanitized);
      if (blocking.length > 0) {
        return {
          result: { ok: true, validationErrors: blocking.map(e => e.message), documentCount: sanitized.length },
          displaySummary: `Draft updated with ${blocking.length} blocking issue(s):\n${formatErrors(blocking)}\n\n${summary}`,
          artifacts: [{ kind: 'decision', title: 'Wiki outline draft edited (with issues)', summary: `${sanitized.length} documents, ${blocking.length} issues remain.`, risk: 'low' }],
        };
      }

      return {
        result: { ok: true, validationErrors: ve.filter(e => e.severity === 'warning').map(e => e.message), documentCount: sanitized.length },
        displaySummary: `Draft updated — all checks passed:\n${summary}`,
        artifacts: [{ kind: 'decision', title: 'Wiki outline draft edited', summary: `${sanitized.length} documents, no blocking issues.`, risk: 'low' }],
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

      const ve = fullValidation(draft.documents, validPaths, { corePackages, strictQuality: true });
      const blocking = blockingErrors(ve);
      if (blocking.length > 0) {
        draft.validationErrors = ve;
        return {
          result: { ok: false, validationErrors: blocking.map(e => e.message), documentCount: draft.documents.length },
          displaySummary: `Submit failed — ${blocking.length} issue(s) remain:\n${formatErrors(blocking)}\nUse wiki.edit_outline_draft to fix them.`,
          artifacts: [{ kind: 'decision', title: 'Wiki outline submit failed', summary: `${blocking.length} issues remain.`, risk: 'low' }],
        };
      }

      draft.locked = true;
      draft.validationErrors = ve.filter(e => e.severity === 'warning');

      const summary = formatOutlineSummary(draft.documents);
      return {
        result: { ok: true, count: draft.documents.length },
        displaySummary: `Outline accepted and locked: ${draft.documents.length} documents.\n${summary}`,
        artifacts: [{ kind: 'decision', title: 'Wiki outline submitted', summary: `${draft.documents.length} documents planned.`, risk: 'low' }],
      };
    },
  };

  return {
    tools: [readTreeTool, createDraftTool, editDraftTool, submitOutlineTool],
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
