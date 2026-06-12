import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeMapScanResult, CodeMapImport, CodeMapModuleSummary } from '../contracts/code-map.js';
import type { FileEntry, SymbolEntry } from '../contracts/forest.js';
import type { WikiOutlineEntry } from './wiki-loop-tools.js';
import { topDirFromPath } from '../analyzer/shared.js';

const MAX_SYMBOLS_PER_FILE = 20;
const MAX_IMPORTS_PER_FILE = 15;
const MAX_SOURCE_FILES = 5;
const MAX_SOURCE_LINES = 120;
const MAX_CONTEXT_CHARS = 32000;

export function buildDocumentContext(scan: CodeMapScanResult, entry: WikiOutlineEntry): string {
  const { codeIndex, moduleMap } = scan;
  const sections: string[] = [];

  sections.push(`# Document: ${entry.title} (${entry.docType})`);

  if (entry.keyQuestions.length > 0) {
    sections.push(`\n## Key Questions\n${entry.keyQuestions.map(q => `- ${q}`).join('\n')}`);
  }

  const targetFiles = resolveTargetFiles(entry.targetFiles, codeIndex.files);
  if (targetFiles.length === 0) {
    sections.push('\n## Note\nNo matching source files found for this document.');
    return sections.join('\n');
  }

  const fileIds = new Set(targetFiles.map(f => f.id));

  const fileSymbols = codeIndex.symbols.filter(s => fileIds.has(s.fileId));
  const fileImports = codeIndex.imports.filter(i => fileIds.has(i.sourceFileId));

  sections.push(formatFileSection(targetFiles));
  sections.push(formatSourceExcerptSection(scan.workDir, targetFiles));
  sections.push(formatSymbolSection(targetFiles, fileSymbols));
  sections.push(formatImportSection(targetFiles, fileImports, codeIndex.files));

  if (moduleMap) {
    const moduleSummary = resolveModuleSummary(targetFiles, moduleMap.topDirs);
    if (moduleSummary) {
      sections.push(formatModuleSection(moduleSummary));
    }
  }

  let result = sections.join('\n');
  if (result.length > MAX_CONTEXT_CHARS) {
    result = result.slice(0, MAX_CONTEXT_CHARS) + '\n…(truncated)';
  }
  return result;
}

function resolveTargetFiles(targetPaths: string[], allFiles: FileEntry[]): FileEntry[] {
  const resolved: FileEntry[] = [];
  for (const target of targetPaths) {
    const match = allFiles.find(f => f.path === target || f.path.endsWith(`/${target}`));
    if (match) resolved.push(match);
  }
  return resolved;
}

function formatFileSection(files: FileEntry[]): string {
  const lines = files.map(f => `- ${f.path} (${f.language}, ${f.size}B)`);
  return `\n## Target Files (${files.length})\n${lines.join('\n')}`;
}

function formatSourceExcerptSection(workDir: string, files: FileEntry[]): string {
  const prioritized = [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_SOURCE_FILES);

  const sections: string[] = ['\n## Source Excerpts'];
  for (const file of prioritized) {
    const excerpt = readSourceExcerpt(workDir, file.path);
    if (!excerpt) continue;
    sections.push(`\n### ${file.path}\n\`\`\`${file.language}\n${excerpt}\n\`\`\``);
  }

  return sections.length > 1 ? sections.join('\n') : '';
}

function readSourceExcerpt(workDir: string, relativePath: string): string | null {
  try {
    const absolutePath = join(workDir, relativePath);
    const raw = readFileSync(absolutePath, 'utf8');
    const lines = raw.split(/\r?\n/).slice(0, MAX_SOURCE_LINES);
    const excerpt = lines.join('\n').trimEnd();
    if (!excerpt) return null;
    if (raw.split(/\r?\n/).length > MAX_SOURCE_LINES) {
      return `${excerpt}\n// …(${MAX_SOURCE_LINES} lines shown)`;
    }
    return excerpt;
  } catch {
    return null;
  }
}

function formatSymbolSection(files: FileEntry[], symbols: SymbolEntry[]): string {
  if (symbols.length === 0) return '';
  const lines: string[] = [];
  for (const file of files) {
    const fileSyms = symbols
      .filter(s => s.fileId === file.id)
      .slice(0, MAX_SYMBOLS_PER_FILE);
    if (fileSyms.length === 0) continue;
    lines.push(`\n### ${file.path}`);
    for (const sym of fileSyms) {
      const sig = sym.signature ? `: ${sym.signature}` : '';
      lines.push(`- ${sym.kind} ${sym.qualifiedName}${sig} (L${sym.range.startLine})`);
    }
  }
  return lines.length > 0 ? `\n## Symbols${lines.join('\n')}` : '';
}

function formatImportSection(
  files: FileEntry[],
  imports: CodeMapImport[],
  allFiles: FileEntry[],
): string {
  if (imports.length === 0) return '';
  const fileMap = new Map(allFiles.map(f => [f.id, f.path]));
  const lines: string[] = [];
  for (const file of files) {
    const fileImps = imports
      .filter(i => i.sourceFileId === file.id)
      .slice(0, MAX_IMPORTS_PER_FILE);
    if (fileImps.length === 0) continue;
    lines.push(`\n### ${file.path}`);
    for (const imp of fileImps) {
      const label = imp.isExternal ? '(ext)' : '(int)';
      lines.push(`- ${imp.targetModule} ${label}`);
    }
  }
  return lines.length > 0 ? `\n## Dependencies${lines.join('\n')}` : '';
}

function resolveModuleSummary(
  files: FileEntry[],
  topDirs: CodeMapModuleSummary[],
): CodeMapModuleSummary | null {
  const dirCounts = new Map<string, number>();
  for (const file of files) {
    const dir = topDirFromPath(file.path);
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }
  let bestDir = '';
  let bestCount = 0;
  for (const [dir, count] of dirCounts) {
    if (count > bestCount) { bestDir = dir; bestCount = count; }
  }
  if (!bestDir) return null;
  return topDirs.find(m => m.path === bestDir) ?? null;
}

function formatModuleSection(mod: CodeMapModuleSummary): string {
  const langs = Object.entries(mod.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => `${lang}(${count})`)
    .join(', ');
  return [
    `\n## Module: ${mod.path}`,
    `- Files: ${mod.fileCount}, Symbols: ${mod.symbolCount}`,
    `- Languages: ${langs}`,
    `- Imports in: ${mod.importsIn}, out: ${mod.importsOut}`,
  ].join('\n');
}
