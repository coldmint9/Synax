import type { CodeMapScanResult, CodeMapSymbolSummary } from '../../contracts/code-map.js';
import { buildAnalyzerGraph } from '../../analyzer/graph.js';
import { buildHubSymbols } from '../../analyzer/community.js';

export interface PackageBaseline {
  id: string;
  label: string;
  dirPath: string;
  fileIds: string[];
  fileCount: number;
  symbolCount: number;
  hubSymbols: CodeMapSymbolSummary[];
}

const EXCLUDED_PACKAGE_DIRS = new Set(['__tests__', '__smoke__', '__mocks__', '__fixtures__']);

export function derivePackages(scan: CodeMapScanResult): PackageBaseline[] {
  const files = scan.codeIndex.files;
  const filePaths = files.map(f => f.path);
  const fileById = new Map(files.map(f => [f.path, f]));

  // Source roots: top-level directories under workspace root
  const roots = findSourceRoots(filePaths);

  // Collect packages from each root
  const allPackages: PackageBaseline[] = [];
  for (const root of roots) {
    const dirs = collectPackageDirs(root, filePaths);
    for (const dir of dirs) {
      const pkg = buildPackage(scan, dir, fileById);
      if (pkg) allPackages.push(pkg);
    }
  }

  return allPackages.sort((a, b) => b.fileCount - a.fileCount);
}

function findSourceRoots(filePaths: string[]): string[] {
  const roots = new Set<string>();
  for (const p of filePaths) {
    const slash = p.indexOf('/');
    if (slash === -1) continue;
    roots.add(p.slice(0, slash));
  }
  return [...roots].sort();
}

function collectPackageDirs(rootPath: string, filePaths: string[]): string[] {
  const subdirs = listImmediateSubdirs(rootPath, filePaths);

  if (subdirs.length >= 2) {
    const packages: string[] = [];
    for (const subdir of subdirs) {
      packages.push(...collectPackageDirs(subdir, filePaths));
    }
    // Also include rootPath if it has own files (not just subdirs)
    if (hasOwnFiles(rootPath, filePaths)) packages.push(rootPath);
    return packages;
  }

  if (subdirs.length === 1) {
    const singleDir = subdirs[0];
    if (hasOwnFiles(rootPath, filePaths)) {
      return [rootPath, ...collectPackageDirs(singleDir, filePaths)];
    }
    return collectPackageDirs(singleDir, filePaths);
  }

  // subdirs.length === 0: leaf
  return [rootPath];
}

function listImmediateSubdirs(rootPath: string, filePaths: string[]): string[] {
  const prefix = rootPath + '/';
  const dirs = new Set<string>();
  for (const p of filePaths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const firstSlash = rest.indexOf('/');
    if (firstSlash === -1) continue; // file directly in rootPath
    const subdir = rest.slice(0, firstSlash);
    if (EXCLUDED_PACKAGE_DIRS.has(subdir)) continue;
    dirs.add(prefix + subdir);
  }
  return [...dirs].sort();
}

function hasOwnFiles(dirPath: string, filePaths: string[]): boolean {
  const prefix = dirPath + '/';
  return filePaths.some(p => {
    if (!p.startsWith(prefix)) return false;
    const rest = p.slice(prefix.length);
    return rest.indexOf('/') === -1; // file directly in dirPath
  });
}

function buildPackage(
  scan: CodeMapScanResult,
  dirPath: string,
  fileById: Map<string, { id: string; path: string }>,
): PackageBaseline | null {
  const files = scan.codeIndex.files.filter(f => f.path.startsWith(dirPath + '/'));
  const graph = buildAnalyzerGraph(scan.codeIndex);
  const fileIds = files.map(f => f.id);

  if (fileIds.length === 0) return null;

  const symbols = scan.codeIndex.symbols.filter(s => {
    const f = files.find(ff => ff.id === s.fileId);
    return f != null;
  });

  const hubSymbols = buildHubSymbols(scan.codeIndex, graph, fileIds);

  return {
    id: `pkg:${dirPath.replace(/[/\\]/g, '-')}`,
    label: dirToLabel(dirPath),
    dirPath,
    fileIds,
    fileCount: fileIds.length,
    symbolCount: symbols.length,
    hubSymbols,
  };
}

function dirToLabel(dirPath: string): string {
  const parts = dirPath.split('/');
  // Return the last 2 segments if deep enough, else the last
  return parts.length >= 2 ? parts.slice(-2).join('/') : parts[parts.length - 1];
}
