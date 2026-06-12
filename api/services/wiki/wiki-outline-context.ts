/**
 * Deterministic, millisecond-level context enrichment for the fast-path
 * outline generator. Extracts everything the LLM needs to plan a high-quality
 * wiki skeleton in a single call — no agentic exploration required.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CodeMapScanResult } from '../contracts/code-map.js';
import { derivePackages, filterBaselineForPrompt, type PackageBaseline } from './tools/package-baseline.js';
import { FILE_SPLIT, SYM_SPLIT } from './tools/contracts.js';
import { buildTreeString } from './tools/helpers.js';

const MAX_HUB_SYMBOLS = 5;
const MAX_FILES_PER_PACKAGE = 8;
const MAX_DEPENDENCY_EDGES = 40;
const MAX_ENTRY_FILES = 10;
const README_MAX_LINES = 60;
const TREE_DEPTH = 3;
const MAX_TREE_FILES = 4000;

export interface OutlineContextResult {
  context: string;
  corePackages: PackageBaseline[];
}

export function buildOutlineContext(scan: CodeMapScanResult, workDir: string): OutlineContextResult {
  const corePackages = filterBaselineForPrompt(derivePackages(scan));

  const segments = [
    buildPackagesSegment(scan, corePackages),
    buildDependencySegment(scan),
    buildEntryFilesSegment(scan),
    buildAnchorsSegment(workDir),
    buildTreeSegment(scan),
  ].filter(Boolean);

  return { context: segments.join('\n\n'), corePackages };
}

// ── Packages with hub symbol signatures and file inventories ────────────────

function buildPackagesSegment(scan: CodeMapScanResult, corePackages: PackageBaseline[]): string {
  if (corePackages.length === 0) return '';

  const symbolById = new Map(scan.codeIndex.symbols.map(s => [s.id, s]));
  const symbolCountByFile = new Map<string, number>();
  for (const s of scan.codeIndex.symbols) {
    symbolCountByFile.set(s.fileId, (symbolCountByFile.get(s.fileId) ?? 0) + 1);
  }
  const fileById = new Map(scan.codeIndex.files.map(f => [f.id, f]));

  const lines: string[] = [];
  lines.push('## Core Packages');
  lines.push('Each core package below MUST be covered by at least one module document (its targetFiles must include files from the package).');
  lines.push('');

  for (const pkg of corePackages) {
    const needsSplit = pkg.fileCount >= FILE_SPLIT && pkg.symbolCount >= SYM_SPLIT;
    lines.push(`### ${pkg.label} (${pkg.dirPath}) — ${pkg.fileCount} files / ${pkg.symbolCount} symbols${needsSplit ? ' [SPLIT: warrants parent + sub-documents]' : ''}`);

    const hubs = pkg.hubSymbols.slice(0, MAX_HUB_SYMBOLS);
    if (hubs.length > 0) {
      lines.push('Hub symbols:');
      for (const hub of hubs) {
        const entry = symbolById.get(hub.id);
        const sig = entry?.signature ? ` — \`${truncate(entry.signature, 140)}\`` : '';
        lines.push(`- [${hub.kind}] ${hub.qualifiedName} (${hub.path})${sig}`);
      }
    }

    const topFiles = pkg.fileIds
      .map(fid => fileById.get(fid))
      .filter((f): f is NonNullable<typeof f> => f != null)
      .sort((a, b) => (symbolCountByFile.get(b.id) ?? 0) - (symbolCountByFile.get(a.id) ?? 0))
      .slice(0, MAX_FILES_PER_PACKAGE);
    if (topFiles.length > 0) {
      lines.push(`Key files: ${topFiles.map(f => f.path).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ── Cross-package dependency edges ───────────────────────────────────────────

function buildDependencySegment(scan: CodeMapScanResult): string {
  const deps = scan.moduleMap?.dependencies ?? [];
  if (deps.length === 0) return '';

  const top = [...deps]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_DEPENDENCY_EDGES);

  const lines = ['## Module Dependencies (top edges by weight)'];
  for (const d of top) {
    lines.push(`- ${d.source} -> ${d.target} (${d.kind}, w=${d.weight})`);
  }
  return lines.join('\n');
}

// ── Entry files ──────────────────────────────────────────────────────────────

function buildEntryFilesSegment(scan: CodeMapScanResult): string {
  const entries = scan.moduleMap?.entryFiles ?? [];
  if (entries.length === 0) return '';
  const lines = ['## Entry Files'];
  for (const f of entries.slice(0, MAX_ENTRY_FILES)) {
    lines.push(`- ${f.path} (${f.language}, ${f.symbolCount} symbols)`);
  }
  return lines.join('\n');
}

// ── Semantic anchors from disk (README, package manifest) ───────────────────

function buildAnchorsSegment(workDir: string): string {
  const parts: string[] = [];

  const readme = readReadme(workDir);
  if (readme) {
    parts.push(`## README (first ${README_MAX_LINES} lines)\n\n\`\`\`\n${readme}\n\`\`\``);
  }

  const manifest = readPackageManifest(workDir);
  if (manifest) {
    parts.push(`## Package Manifest\n\n${manifest}`);
  }

  return parts.join('\n\n');
}

function readReadme(workDir: string): string | null {
  for (const name of ['README.md', 'readme.md', 'README.rst', 'README']) {
    try {
      const raw = fs.readFileSync(path.join(workDir, name), 'utf8');
      return raw.split('\n').slice(0, README_MAX_LINES).join('\n').trim() || null;
    } catch {
      continue;
    }
  }
  return null;
}

function readPackageManifest(workDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(workDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const lines: string[] = [];
    if (pkg.name) lines.push(`- name: ${pkg.name}`);
    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
      const scripts = Object.entries(pkg.scripts).slice(0, 12).map(([k, v]) => `${k}: \`${truncate(v, 80)}\``);
      lines.push(`- scripts: ${scripts.join('; ')}`);
    }
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      lines.push(`- dependencies: ${Object.keys(pkg.dependencies).slice(0, 30).join(', ')}`);
    }
    if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) {
      lines.push(`- devDependencies: ${Object.keys(pkg.devDependencies).slice(0, 15).join(', ')}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  } catch {
    return null;
  }
}

// ── Directory tree with the path constraint ──────────────────────────────────

function buildTreeSegment(scan: CodeMapScanResult): string {
  const files = scan.codeIndex.files.map(f => f.path).slice(0, MAX_TREE_FILES);
  const tree = buildTreeString(files, '', TREE_DEPTH);
  return [
    '## Directory Tree (depth 3)',
    '',
    '```',
    tree,
    '```',
    '',
    '**Path constraint:** every entry in targetFiles MUST be an existing file path from this scan — prefer the "Key files" and "Entry Files" listed above. Do not invent paths.',
  ].join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
