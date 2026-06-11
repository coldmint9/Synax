import type { CodeMapScanResult } from '../contracts/code-map.js';

/** Directory segments that are excluded from the tree along with their descendants. */
const EXCLUDED_DIRS = new Set([
  '__tests__',
  '__smoke__',
  '__mocks__',
  '__fixtures__',
  'node_modules',
  'dist',
  '.git',
  'dist-electron',
  '.data',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEligiblePaths(scan: CodeMapScanResult): string[] {
  return scan.codeIndex.files
    .map((f) => f.path)
    .filter((p) => !p.split('/').some((seg) => EXCLUDED_DIRS.has(seg)));
}

function renderTree(filePaths: string[]): string {
  const allDirs = new Set<string>();
  for (const p of filePaths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      allDirs.add(parts.slice(0, i).join('/'));
    }
  }
  const dirCounts = new Map<string, number>();
  for (const dir of allDirs) {
    dirCounts.set(dir, filePaths.filter((p) => p.startsWith(dir + '/')).length);
  }
  const sorted = [...allDirs].sort();
  const lines: string[] = [];
  for (const dir of sorted) {
    const depth = dir.split('/').length;
    const indent = '  '.repeat(depth);
    const count = dirCounts.get(dir)!;
    lines.push(`${indent}${dir}/  (${count} files)`);
  }
  return lines.join('\n');
}

function buildProjectStats(scan: CodeMapScanResult): string {
  const langs = scan.moduleMap?.languages ?? [];
  const langStr = langs.length > 0
    ? langs.sort((a, b) => b.fileCount - a.fileCount).slice(0, 5)
      .map((l) => `${l.language} (${l.fileCount})`).join(', ')
    : 'unknown';
  return [
    '## Project Stats',
    `- Files: ${scan.codeIndex.files.length} | Symbols: ${scan.codeIndex.symbols.length}`,
    `- Languages: ${langStr}`,
  ].join('\n');
}

function buildEntryFilesSection(scan: CodeMapScanResult): string {
  const entries = scan.moduleMap?.entryFiles ?? [];
  if (entries.length === 0) return '';
  const top = entries.slice(0, 10);
  return [
    '## Entry Files',
    ...top.map((e) => `- ${e.path} (${e.language}, ${e.symbolCount} symbols)`),
  ].join('\n');
}

function buildCoreModulesSection(scan: CodeMapScanResult): string {
  const topDirs = scan.moduleMap?.topDirs ?? [];
  const eligible = topDirs.filter((d) => d.fileCount >= 3);
  if (eligible.length === 0) return '';
  return [
    '## Core Modules',
    ...eligible.slice(0, 20).map((m) => {
      const primaryLang = Object.entries(m.languages).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '?';
      return `- ${m.path}/  ${m.fileCount}f / ${m.symbolCount}s  (${primaryLang})`;
    }),
  ].join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Build the complete outline planning context — everything the planner LLM
 * needs to produce a document outline, in one compact markdown string.
 */
export function buildOutlineContext(scan: CodeMapScanResult): string {
  const sections = [
    buildProjectStats(scan),
    '',
    '## Directory Tree',
    '```',
    renderTree(getEligiblePaths(scan)),
    '```',
    buildEntryFilesSection(scan),
    buildCoreModulesSection(scan),
  ].filter((s) => s.length > 0);
  return sections.join('\n');
}

/**
 * Build a pure directory tree string from code-map scan data for LLM
 * consumption.
 *
 * Renders directories as indented relative paths with recursive file
 * counts.  Excluded directories are silently dropped together with all
 * of their descendants.
 */
export function buildDirectoryTree(scan: CodeMapScanResult): string {
  return renderTree(getEligiblePaths(scan));
}
