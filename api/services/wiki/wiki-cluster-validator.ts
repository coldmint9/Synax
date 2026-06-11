// ---------------------------------------------------------------------------
// api/services/wiki/wiki-cluster-validator.ts
// Validates LLM-produced wiki outlines against code-map graph data.
// Each validation dimension is independent — no shared mutable state.
// ---------------------------------------------------------------------------

import path from 'node:path';
import type { CodeMapScanResult } from '../contracts/code-map.js';
import { buildAnalyzerGraph } from '../analyzer/graph.js';
import { FILE_SPLIT, SYM_SPLIT } from './tools/contracts.js';
import type { WikiOutlineEntry } from './tools/contracts.js';

// ── Public Types ──────────────────────────────────────────────────────────────

export interface ClusterFeedback {
  type: 'merge_suggest' | 'coupling_warn' | 'split_suggest';
  severity: 'info' | 'warn';
  subjects: string[];
  evidence: string;
  suggestion: string;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const MERGE_DENSITY_THRESHOLD = 0.3;
const MERGE_DENSITY_WARN = 0.5;
const COUPLING_CALL_THRESHOLD = 10;
const INTERNAL_DENSITY_SPLIT = 0.15;

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Validate an LLM-produced wiki outline against the code-map scan result.
 * Runs three independent validation dimensions and returns actionable feedback.
 */
export default function validateOutlineClusters(
  outline: WikiOutlineEntry[],
  scan: CodeMapScanResult,
): ClusterFeedback[] {
  if (!outline.length) return [];

  const docDirs = getDocumentDirectories(outline, scan);

  const feedback: ClusterFeedback[] = [];
  feedback.push(...checkImportDensity(outline, scan, docDirs));
  feedback.push(...checkCallCoupling(outline, scan, docDirs));
  feedback.push(...checkInternalSplit(outline, scan, docDirs));
  return feedback;
}

// ── Public Helpers ────────────────────────────────────────────────────────────

/**
 * Map each document title to the set of unique directory paths
 * covered by its targetFiles.
 */
export function getDocumentDirectories(
  outline: WikiOutlineEntry[],
  scan: CodeMapScanResult,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const fileByPath = new Map(scan.codeIndex.files.map((f) => [f.path, f] as const));

  for (const entry of outline) {
    const dirs = new Set<string>();
    for (const tf of entry.targetFiles) {
      const file = fileByPath.get(tf);
      if (!file) continue;
      const dir = path.dirname(file.path);
      if (dir === '.') continue;
      dirs.add(dir);
    }
    if (dirs.size > 0) {
      result.set(entry.title, dirs);
    }
  }

  return result;
}

/**
 * Compute the import density between two directory paths.
 *
 * Density = (files in A importing from B + files in B importing from A)
 *           divided by (total files in A + B directories).
 *
 * Uses resolved imports from the analyzer graph for accurate cross-directory
 * import counts.
 */
export function computeImportDensity(
  dirA: string,
  dirB: string,
  scan: CodeMapScanResult,
): number {
  const graph = buildAnalyzerGraph(scan.codeIndex);

  const filesInA = scan.codeIndex.files.filter((f) => f.path.startsWith(dirA + '/'));
  const filesInB = scan.codeIndex.files.filter((f) => f.path.startsWith(dirB + '/'));
  const fileIdsA = new Set(filesInA.map((f) => f.id));
  const fileIdsB = new Set(filesInB.map((f) => f.id));

  const totalFiles = filesInA.length + filesInB.length;
  if (totalFiles === 0) return 0;

  let crossImports = 0;
  for (const edge of graph.resolvedImports) {
    const sourceInA = fileIdsA.has(edge.sourceFileId);
    const targetInB = fileIdsB.has(edge.targetFileId);
    const sourceInB = fileIdsB.has(edge.sourceFileId);
    const targetInA = fileIdsA.has(edge.targetFileId);

    if ((sourceInA && targetInB) || (sourceInB && targetInA)) {
      crossImports += 1;
    }
  }

  return crossImports / totalFiles;
}

// ── Validation Dimensions ─────────────────────────────────────────────────────

/**
 * Check import density between directories covered by different documents.
 *
 * For each pair of different documents, examines all related directory pairs
 * (parent/child or sibling). If import density exceeds the threshold, suggests
 * merging the two documents.
 */
function checkImportDensity(
  outline: WikiOutlineEntry[],
  scan: CodeMapScanResult,
  docDirs: Map<string, Set<string>>,
): ClusterFeedback[] {
  const results: ClusterFeedback[] = [];
  const entries = [...docDirs.entries()];
  const seen = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [titleA, dirsA] = entries[i];
      const [titleB, dirsB] = entries[j];

      for (const dirA of dirsA) {
        for (const dirB of dirsB) {
          if (!areRelatedDirectories(dirA, dirB)) continue;

          // Deduplicate: skip if we already emitted feedback for this directory pair
          const pairKey = [dirA, dirB].sort().join('::');
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);

          const density = computeImportDensity(dirA, dirB, scan);
          if (density >= MERGE_DENSITY_THRESHOLD) {
            results.push({
              type: 'merge_suggest',
              severity: density >= MERGE_DENSITY_WARN ? 'warn' : 'info',
              subjects: [titleA, titleB],
              evidence:
                `Import density between ${dirA}/ and ${dirB}/: ` +
                `${(density * 100).toFixed(1)}% (${density >= MERGE_DENSITY_WARN ? 'strong' : 'moderate'} coupling).`,
              suggestion:
                `High import coupling detected. Consider merging "${titleA}" and ` +
                `"${titleB}" into a single cohesive document covering both directories.`,
            });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Check call-graph coupling between directories in different documents.
 *
 * Uses the analyzer's resolved call graph to count cross-directory call edges.
 * If a directory pair across documents has many call edges, it signals that
 * the documents may be artificially separated.
 */
function checkCallCoupling(
  outline: WikiOutlineEntry[],
  scan: CodeMapScanResult,
  docDirs: Map<string, Set<string>>,
): ClusterFeedback[] {
  // Build directory → document title lookup
  const dirToDoc = new Map<string, string>();
  for (const [title, dirs] of docDirs) {
    for (const dir of dirs) {
      dirToDoc.set(dir, title);
    }
  }

  if (dirToDoc.size < 2) return [];

  const graph = buildAnalyzerGraph(scan.codeIndex);

  // Build symbol → file → directory resolution caches
  const symbolFile = new Map(scan.codeIndex.symbols.map((s) => [s.id, s.fileId] as const));
  const fileDir = new Map(
    scan.codeIndex.files.map((f) => [f.id, path.dirname(f.path)] as const),
  );

  // Count cross-directory call edges, keyed by sorted (dirA, dirB) pair
  const pairKey = (a: string, b: string) => (a < b ? `${a}||${b}` : `${b}||${a}`);
  const crossCounts = new Map<
    string,
    { dirA: string; dirB: string; docA: string; docB: string; count: number }
  >();

  for (const [sourceSymId, targets] of graph.callGraph) {
    const sourceFileId = symbolFile.get(sourceSymId);
    if (!sourceFileId) continue;
    const sourceDir = fileDir.get(sourceFileId);
    if (!sourceDir) continue;
    const sourceDoc = dirToDoc.get(sourceDir);
    if (!sourceDoc) continue;

    for (const targetSymId of targets) {
      const targetFileId = symbolFile.get(targetSymId);
      if (!targetFileId) continue;
      const targetDir = fileDir.get(targetFileId);
      if (!targetDir) continue;
      const targetDoc = dirToDoc.get(targetDir);
      if (!targetDoc) continue;

      // Same document or same directory — not a cross-document coupling signal
      if (sourceDoc === targetDoc) continue;
      if (sourceDir === targetDir) continue;

      const key = pairKey(sourceDir, targetDir);
      const existing = crossCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        crossCounts.set(key, {
          dirA: sourceDir,
          dirB: targetDir,
          docA: sourceDoc,
          docB: targetDoc,
          count: 1,
        });
      }
    }
  }

  const results: ClusterFeedback[] = [];
  for (const [, info] of crossCounts) {
    if (info.count >= COUPLING_CALL_THRESHOLD) {
      results.push({
        type: 'coupling_warn',
        severity: 'warn',
        subjects: [info.docA, info.docB],
        evidence:
          `${info.count} call edges between ${info.dirA}/ and ${info.dirB}/ ` +
          `across document boundaries.`,
        suggestion:
          `High runtime call coupling detected between "${info.docA}" and ` +
          `"${info.docB}". Verify that the document boundary aligns with ` +
          `architectural layers — otherwise consider adjusting the outline.`,
      });
    }
  }

  return results;
}

/**
 * Check whether a single document covers a directory that should be split.
 *
 * Conditions for split suggestion (all must be true):
 * - fileCount >= FILE_SPLIT (20)
 * - symbolCount >= SYM_SPLIT (80)
 * - internal import density < 0.15 (files in the directory rarely import each other)
 */
function checkInternalSplit(
  outline: WikiOutlineEntry[],
  scan: CodeMapScanResult,
  docDirs: Map<string, Set<string>>,
): ClusterFeedback[] {
  const results: ClusterFeedback[] = [];

  for (const [title, dirs] of docDirs) {
    for (const dir of dirs) {
      const filesInDir = scan.codeIndex.files.filter(
        (f) => path.dirname(f.path) === dir,
      );
      const fileIdsInDir = new Set(filesInDir.map((f) => f.id));

      if (filesInDir.length < FILE_SPLIT) continue;

      const symbolsInDir = scan.codeIndex.symbols.filter((s) =>
        fileIdsInDir.has(s.fileId),
      );
      if (symbolsInDir.length < SYM_SPLIT) continue;

      // Compute internal import density
      const graph = buildAnalyzerGraph(scan.codeIndex);
      let internalImports = 0;
      for (const edge of graph.resolvedImports) {
        if (
          fileIdsInDir.has(edge.sourceFileId) &&
          fileIdsInDir.has(edge.targetFileId)
        ) {
          internalImports += 1;
        }
      }

      const internalDensity =
        filesInDir.length > 0 ? internalImports / filesInDir.length : 0;

      if (internalDensity < INTERNAL_DENSITY_SPLIT) {
        results.push({
          type: 'split_suggest',
          severity: 'warn',
          subjects: [title],
          evidence:
            `Directory ${dir}/ has ${filesInDir.length} files and ` +
            `${symbolsInDir.length} symbols, but only ` +
            `${(internalDensity * 100).toFixed(1)}% internal import density ` +
            `(threshold: ${(INTERNAL_DENSITY_SPLIT * 100).toFixed(0)}%).`,
          suggestion:
            `"${title}" may cover too much ground. The directory ${dir}/ ` +
            `is large but internally sparse — consider splitting into ` +
            `multiple smaller documents focused on cohesive subgroups.`,
        });
      }
    }
  }

  return results;
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

/**
 * Two directories are "related" for import-density checking when they are
 * either parent/child (one is a path prefix of the other) or siblings
 * (share the same immediate parent directory).
 */
function areRelatedDirectories(dirA: string, dirB: string): boolean {
  // Parent/child
  if (dirA.startsWith(dirB + '/') || dirB.startsWith(dirA + '/')) return true;

  // Sibling: same immediate parent
  if (path.dirname(dirA) === path.dirname(dirB)) return true;

  return false;
}
