import type { WikiOutlineEntry, ValidationError } from './contracts.js';
import type { PackageBaseline } from './package-baseline.js';
import { isSectionEntry, isWritableOutlineEntry } from './outline-node.js';

const MIN_KEY_QUESTIONS = 2;
const MIN_KEY_QUESTION_LENGTH = 12;

/** Files matching these hints suggest the project has a storage layer worth a data doc. */
const DATA_LAYER_HINT = /(schema|migration|\bstore\b|store\.|database|\bdb\b|\.sql$|prisma|drizzle)/i;

export function validateStructure(documents: WikiOutlineEntry[]): ValidationError[] {
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

  const writable = documents.filter(isWritableOutlineEntry);
  if (writable.length === 0) {
    errors.push({ severity: 'error', field: 'documents', message: 'Need at least 1 writable document (nodeKind=document).' });
  }

  const typeCount = (t: string) => writable.filter(d => d.docType === t).length;
  if (typeCount('landscape') < 1) {
    errors.push({ severity: 'error', field: 'docType', message: 'Need at least 1 landscape document.' });
  }
  if (typeCount('topology') < 1) {
    errors.push({ severity: 'error', field: 'docType', message: 'Need at least 1 topology document.' });
  }

  return errors;
}

export function validateFilePaths(documents: WikiOutlineEntry[], validPaths: Set<string>): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const doc of documents.filter(isWritableOutlineEntry)) {
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

/** Every core package must be covered by at least one module document's targetFiles. */
export function validatePackageCoverage(
  documents: WikiOutlineEntry[],
  corePackages: PackageBaseline[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const moduleDocs = documents.filter(d => d.docType === 'module' && isWritableOutlineEntry(d));
  for (const pkg of corePackages) {
    const prefix = pkg.dirPath + '/';
    const covered = moduleDocs.some(d => d.targetFiles.some(p => p.startsWith(prefix)));
    if (!covered) {
      errors.push({
        severity: 'error',
        field: 'coverage',
        message: `Core package "${pkg.label}" (${pkg.dirPath}) is not covered by any module document's targetFiles.`,
      });
    }
  }
  return errors;
}

/** Each document needs specific key questions — not empty, not one-liners. */
export function validateKeyQuestions(documents: WikiOutlineEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const doc of documents.filter(isWritableOutlineEntry)) {
    const qs = doc.keyQuestions ?? [];
    if (qs.length < MIN_KEY_QUESTIONS) {
      errors.push({
        severity: 'error',
        field: 'keyQuestions',
        message: `"${doc.title}" needs at least ${MIN_KEY_QUESTIONS} keyQuestions (found ${qs.length}).`,
      });
      continue;
    }
    const vague = qs.filter(q => q.trim().length < MIN_KEY_QUESTION_LENGTH);
    if (vague.length > 0) {
      errors.push({
        severity: 'error',
        field: 'keyQuestions',
        message: `"${doc.title}" has ${vague.length} keyQuestion(s) too short/vague (min ${MIN_KEY_QUESTION_LENGTH} chars).`,
      });
    }
  }
  return errors;
}

/** Soft expectation: prefer hierarchical parentId over a fully flat outline. */
export function validateHierarchy(documents: WikiOutlineEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const hasNesting = documents.some(d => d.parentId);
  if (!hasNesting && documents.length > 1) {
    errors.push({
      severity: 'warning',
      field: 'parentId',
      message: 'Outline is flat — prefer hierarchical parentId structure for a professional TOC.',
    });
  }
  return errors;
}

/** Soft expectations: at least 1 flow doc; a data doc when a storage layer is detectable. */
export function validateDocTypeMix(
  documents: WikiOutlineEntry[],
  validPaths: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const writable = documents.filter(isWritableOutlineEntry);
  if (!writable.some(d => d.docType === 'flow')) {
    errors.push({ severity: 'warning', field: 'docType', message: 'No flow document — consider documenting at least one end-to-end operation.' });
  }
  const hasDataLayer = [...validPaths].some(p => DATA_LAYER_HINT.test(p));
  if (hasDataLayer && !writable.some(d => d.docType === 'data')) {
    errors.push({ severity: 'warning', field: 'docType', message: 'Project appears to have a storage layer but the outline has no data document.' });
  }
  return errors;
}

export interface FullValidationOptions {
  /** When provided, package coverage is enforced. */
  corePackages?: PackageBaseline[];
  /** When true, keyQuestions depth and docType mix are enforced (fast path + final submit). */
  strictQuality?: boolean;
}

export function fullValidation(
  documents: WikiOutlineEntry[],
  validPaths: Set<string>,
  opts: FullValidationOptions = {},
): ValidationError[] {
  const errors = [
    ...validateStructure(documents),
    ...validateFilePaths(documents, validPaths),
  ];
  if (opts.corePackages && opts.corePackages.length > 0) {
    errors.push(...validatePackageCoverage(documents, opts.corePackages));
  }
  if (opts.strictQuality) {
    errors.push(...validateKeyQuestions(documents));
    errors.push(...validateHierarchy(documents));
    errors.push(...validateDocTypeMix(documents, validPaths));
  }
  return errors;
}

/** Only severity=error entries block submission; warnings are advisory. */
export function blockingErrors(errors: ValidationError[]): ValidationError[] {
  return errors.filter(e => e.severity === 'error');
}

export function formatErrors(errors: ValidationError[]): string {
  return errors.map(e => `  - [${e.severity}] ${e.field}: ${e.message}`).join('\n');
}
