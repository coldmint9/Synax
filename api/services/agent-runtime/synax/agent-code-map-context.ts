import fs from 'node:fs';
import path from 'node:path';
import type { CodeMapScanResult, CodeMapSymbolSummary } from '../../contracts/code-map.js';
import { derivePackages, filterBaselineForPrompt, type PackageBaseline } from '../../wiki/tools/package-baseline.js';

const MAX_HUB_SYMBOLS = 5;
const MAX_FILES_PER_PACKAGE = 8;
const MAX_DEPENDENCY_EDGES = 15;
const MAX_ENTRY_FILES = 10;
const README_MAX_LINES = 30;
const MAX_AGENT_CODE_MAP_CHARS = 6_000;

const TEST_PATH_RE = /(^|\/)(__tests__|__smoke__|__mocks__|__fixtures__)(\/|$)/;
const TEST_FILE_RE = /\.(test|spec)\.(tsx?|jsx?|mjs|cjs)$/;

export function isAgentRelevantPath(filePath: string): boolean {
  return !TEST_PATH_RE.test(filePath) && !TEST_FILE_RE.test(filePath);
}

export interface BuildAgentCodeMapContextOptions {
  focusPrompt?: string;
  maxChars?: number;
}

export function buildAgentCodeMapContext(
  scan: CodeMapScanResult,
  workDir: string,
  options: BuildAgentCodeMapContextOptions = {},
): string {
  const maxChars = options.maxChars ?? MAX_AGENT_CODE_MAP_CHARS;
  let corePackages = filterBaselineForPrompt(derivePackages(scan));

  if (options.focusPrompt?.trim()) {
    corePackages = sortPackagesByFocus(corePackages, options.focusPrompt);
  }

  const segments = [
    buildPackagesSegment(scan, corePackages),
    buildDependencySegment(scan),
    buildEntryFilesSegment(scan),
    buildReadmeExcerpt(workDir),
  ].filter(Boolean);

  const joined = segments.join('\n\n');
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars - 40)}\n\n[...truncated for context budget...]`;
}

function sortPackagesByFocus(packages: PackageBaseline[], focusPrompt: string): PackageBaseline[] {
  const tokens = focusPrompt
    .toLowerCase()
    .split(/[^a-z0-9/_-]+/)
    .filter((token) => token.length >= 3);
  if (tokens.length === 0) return packages;

  const score = (pkg: PackageBaseline): number => {
    const haystack = `${pkg.label} ${pkg.dirPath}`.toLowerCase();
    return tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
  };

  return [...packages].sort((left, right) => score(right) - score(left) || right.fileCount - left.fileCount);
}

function buildPackagesSegment(scan: CodeMapScanResult, corePackages: PackageBaseline[]): string {
  if (corePackages.length === 0) return '';

  const symbolById = new Map(scan.codeIndex.symbols.map((symbol) => [symbol.id, symbol]));
  const symbolCountByFile = new Map<string, number>();
  for (const symbol of scan.codeIndex.symbols) {
    symbolCountByFile.set(symbol.fileId, (symbolCountByFile.get(symbol.fileId) ?? 0) + 1);
  }
  const fileById = new Map(scan.codeIndex.files.map((file) => [file.id, file]));

  const lines: string[] = ['## Core Packages'];
  for (const pkg of corePackages) {
    lines.push(`### ${pkg.label} (${pkg.dirPath}) — ${pkg.fileCount} files / ${pkg.symbolCount} symbols`);

    const hubs = pkg.hubSymbols
      .filter((hub) => isAgentRelevantPath(hub.path))
      .slice(0, MAX_HUB_SYMBOLS);
    if (hubs.length > 0) {
      lines.push('Hub symbols:');
      for (const hub of hubs) {
        lines.push(formatHubLine(hub, symbolById.get(hub.id)));
      }
    }

    const topFiles = pkg.fileIds
      .map((fileId) => fileById.get(fileId))
      .filter((file): file is NonNullable<typeof file> => file != null && isAgentRelevantPath(file.path))
      .sort((left, right) => (symbolCountByFile.get(right.id) ?? 0) - (symbolCountByFile.get(left.id) ?? 0))
      .slice(0, MAX_FILES_PER_PACKAGE);
    if (topFiles.length > 0) {
      lines.push(`Key files: ${topFiles.map((file) => file.path).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function formatHubLine(
  hub: CodeMapSymbolSummary,
  entry?: { signature?: string | null },
): string {
  const sig = entry?.signature ? ` — \`${truncate(entry.signature, 120)}\`` : '';
  return `- [${hub.kind}] ${hub.qualifiedName} (${hub.path})${sig}`;
}

function buildDependencySegment(scan: CodeMapScanResult): string {
  const deps = scan.moduleMap?.dependencies ?? [];
  if (deps.length === 0) return '';

  const top = [...deps]
    .sort((left, right) => right.weight - left.weight)
    .slice(0, MAX_DEPENDENCY_EDGES);

  const lines = ['## Module Dependencies (top edges by weight)'];
  for (const dep of top) {
    lines.push(`- ${dep.source} -> ${dep.target} (${dep.kind}, w=${dep.weight})`);
  }
  return lines.join('\n');
}

function buildEntryFilesSegment(scan: CodeMapScanResult): string {
  const entries = (scan.moduleMap?.entryFiles ?? []).filter((file) => isAgentRelevantPath(file.path));
  if (entries.length === 0) return '';
  const lines = ['## Entry Files'];
  for (const file of entries.slice(0, MAX_ENTRY_FILES)) {
    lines.push(`- ${file.path} (${file.language}, ${file.symbolCount} symbols)`);
  }
  return lines.join('\n');
}

function buildReadmeExcerpt(workDir: string): string {
  for (const name of ['README.md', 'readme.md']) {
    try {
      const raw = fs.readFileSync(path.join(workDir, name), 'utf8');
      const excerpt = raw.split('\n').slice(0, README_MAX_LINES).join('\n').trim();
      if (excerpt) {
        return `## README excerpt\n\n\`\`\`\n${excerpt}\n\`\`\``;
      }
    } catch {
      continue;
    }
  }
  return '';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
