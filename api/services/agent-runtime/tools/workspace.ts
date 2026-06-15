import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../../../lib/env.js';
import { sandboxPolicy } from '../sandbox/index.js';

const SECRET_SEGMENTS = new Set(['.env', '.ssh', '.git', 'node_modules', 'dist', 'build']);
const sessionWorkspaceRoots = new Map<string, string>();

function hasBlockedSegment(parts: string[]): boolean {
  return parts.some((part) => SECRET_SEGMENTS.has(part) || part.endsWith('.key') || part.endsWith('.pem'));
}

export function workspaceRoot(sessionId?: string): string {
  return sessionId ? sessionWorkspaceRoots.get(sessionId) ?? path.resolve(process.cwd()) : path.resolve(process.cwd());
}

export function resolveWorkspaceRoot(inputPath = '.'): string {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error('Workspace root must point to a directory.');
  return resolved;
}

export function setSessionWorkspaceRoot(sessionId: string, inputPath: string): string {
  const root = resolveWorkspaceRoot(inputPath);
  sessionWorkspaceRoots.set(sessionId, root);
  return root;
}

export function tryGetSessionWorkspaceRoot(sessionId: string): string | undefined {
  return sessionWorkspaceRoots.get(sessionId);
}

interface ProjectWorkDirEntry {
  id: string;
  source?: { localPath?: string };
}

function readProjectWorkDirEntries(): ProjectWorkDirEntry[] {
  const projectsFile = path.join(DATA_ROOT, 'projects.json');
  const raw = JSON.parse(fs.readFileSync(projectsFile, 'utf8')) as unknown;
  if (Array.isArray(raw)) return raw as ProjectWorkDirEntry[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)) {
    return (raw as { items: ProjectWorkDirEntry[] }).items;
  }
  return [];
}

/** Resolve a project's workspace root from the on-disk project registry. */
export function resolveProjectWorkDir(projectId: string): string {
  try {
    const project = readProjectWorkDirEntries().find((entry) => entry.id === projectId);
    if (project?.source?.localPath) {
      return path.resolve(project.source.localPath);
    }
  } catch {
    // fall through
  }
  return path.resolve(process.cwd());
}

/** Prefer an explicit session workspace root, then the project's registered path. */
export function resolveSessionWorkDir(sessionId: string, projectId: string): string {
  return tryGetSessionWorkspaceRoot(sessionId) ?? resolveProjectWorkDir(projectId);
}

export function clearSessionWorkspaceRoot(sessionId: string): void {
  sessionWorkspaceRoots.delete(sessionId);
}

function workspaceRootForSession(sessionId?: string): string {
  return workspaceRoot(sessionId);
}

export function resolveWorkspacePath(inputPath = '.', sessionId?: string): string {
  const root = workspaceRootForSession(sessionId);
  return sandboxPolicy.resolve(inputPath, root, sessionId ?? '__default__', 'workspace');
}

export function toWorkspaceRelative(absPath: string, sessionId?: string): string {
  let root = workspaceRootForSession(sessionId);
  try { root = fs.realpathSync(root); } catch { /* keep as-is */ }
  return path.relative(root, absPath).replace(/\\/g, '/') || '.';
}

export function isWorkspaceRelativePathBlocked(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.') return false;
  return hasBlockedSegment(normalized.split('/').filter(Boolean));
}

export function isWorkspaceEntryVisible(name: string): boolean {
  return !hasBlockedSegment([name]);
}

export function walkFiles(rootPath: string, limit = 500): string[] {
  const out: string[] = [];
  const visit = (current: string) => {
    if (out.length >= limit) return;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (SECRET_SEGMENTS.has(entry.name)) continue;
        visit(path.join(current, entry.name));
        if (out.length >= limit) break;
      }
      return;
    }
    if (stat.isFile()) out.push(current);
  };
  visit(rootPath);
  return out;
}
