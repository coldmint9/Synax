import fs from 'node:fs';
import path from 'node:path';

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

export function clearSessionWorkspaceRoot(sessionId: string): void {
  sessionWorkspaceRoots.delete(sessionId);
}

function workspaceRootForSession(sessionId?: string): string {
  return workspaceRoot(sessionId);
}

export function resolveWorkspacePath(inputPath = '.', sessionId?: string): string {
  const root = workspaceRootForSession(sessionId);
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, inputPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path is outside the Synapse workspace.');
  }
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  if (hasBlockedSegment(parts)) {
    throw new Error('Path is blocked by the read guard.');
  }
  return resolved;
}

export function toWorkspaceRelative(absPath: string, sessionId?: string): string {
  return path.relative(workspaceRootForSession(sessionId), absPath).replace(/\\/g, '/') || '.';
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
