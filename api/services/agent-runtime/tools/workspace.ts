import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../../../lib/env.js';
import { agentRuntimeStore } from '../session-store.js';
import { sandboxConfigForSession, sandboxPolicy } from '../sandbox/index.js';
import { canonicalWorkspaceDirectory, projectWorkspaceRoots, readWorkspaceProject, type ProjectWorkspaceRoot } from '../../project-workspace.js';

const sessionWorkspaceRoots = new Map<string, string>();

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

/** A reference picker must not silently fall back to the server workspace. */
export function resolveRegisteredProjectWorkDir(projectId: string): string {
  const registered = readProjectWorkDirEntriesSafely().find(entry => entry.id === projectId)?.source?.localPath;
  if (!registered) throw new Error('The project has no registered workspace.');
  return fs.realpathSync(resolveWorkspaceRoot(registered));
}

/** Prefer an explicit session workspace root, then the project's registered path. */
export function resolveSessionWorkDir(sessionId: string, projectId: string): string {
  const binding = agentRuntimeStore.tryGetSession(sessionId)?.sessionMetadata?.backend as { workDir?: string | null } | undefined;
  return binding?.workDir ?? tryGetSessionWorkspaceRoot(sessionId) ?? resolveProjectWorkDir(projectId);
}

/** A persisted membership snapshot also works in session worker processes. */
export function resolveSessionWorkspaceRoots(sessionId: string, projectId: string): ProjectWorkspaceRoot[] {
  const binding = agentRuntimeStore.tryGetSession(sessionId)?.sessionMetadata?.backend as { workspaceRoots?: ProjectWorkspaceRoot[] } | undefined;
  if (binding?.workspaceRoots) return binding.workspaceRoots;
  const project = readWorkspaceProject(projectId);
  const primary = resolveSessionWorkDir(sessionId, projectId);
  return [
    { id: projectId, name: project?.name ?? projectId, path: primary, role: 'primary', status: 'available' },
    ...(project ? projectWorkspaceRoots(project).filter(root => root.role === 'reference') : []),
  ];
}

/** Freeze the real execution root before accepting work; never infer it from server cwd. */
export function bindSessionWorkDir(sessionId: string): string {
  const session = agentRuntimeStore.getSession(sessionId);
  const binding = session.sessionMetadata?.backend as { workDir?: string | null } | undefined;
  const registered = readProjectWorkDirEntriesSafely().find((entry) => entry.id === session.projectId)?.source?.localPath;
  const requested = binding?.workDir ?? tryGetSessionWorkspaceRoot(sessionId) ?? registered;
  if (!requested) throw new Error('The session has no registered workspace. Select an existing working directory before executing.');
  const root = fs.realpathSync(resolveWorkspaceRoot(requested));
  // Refresh between executions. Never change the directory set during an active run.
  const previous = binding as { workspaceRoots?: ProjectWorkspaceRoot[] } | undefined;
  const project = readWorkspaceProject(session.projectId);
  const roots = (session.activeRunId || session.parentSessionId) && previous?.workspaceRoots
    ? previous.workspaceRoots
    : [
        { id: session.projectId, name: project?.name ?? session.projectId, path: root, role: 'primary' as const, status: 'available' as const },
        ...(project ? projectWorkspaceRoots(project).filter(item => item.role === 'reference') : []),
      ];
  const workspaceRoots = roots.map(item => ({ ...item, path: canonicalWorkspaceDirectory(item.path), status: 'available' as const }));
  setSessionWorkspaceRoot(sessionId, root);
  agentRuntimeStore.updateSessionMetadata(sessionId, { backend: { ...binding, workDir: root, workspaceRoots } });
  return root;
}

function readProjectWorkDirEntriesSafely(): ProjectWorkDirEntry[] {
  try { return readProjectWorkDirEntries(); } catch { return []; }
}

export function clearSessionWorkspaceRoot(sessionId: string): void {
  sessionWorkspaceRoots.delete(sessionId);
}

function workspaceRootForSession(sessionId?: string): string {
  return workspaceRoot(sessionId);
}

/**
 * Resolve a tool path. Non-unrestricted sessions stay inside the workspace and
 * keep the remaining sandbox rules; unrestricted sessions resolve anywhere.
 */
export function resolveWorkspacePath(inputPath = '.', sessionId?: string): string {
  const root = workspaceRootForSession(sessionId);
  return sandboxPolicy.resolve(inputPath, root, sessionId ?? '__default__', 'workspace');
}

export function toWorkspaceRelative(absPath: string, sessionId?: string): string {
  let root = workspaceRootForSession(sessionId);
  try { root = fs.realpathSync(root); } catch { /* keep as-is */ }
  const relative = path.relative(root, absPath).replace(/\\/g, '/');
  if (!relative) return '.';
  // Unrestricted sessions can leave the root; show the absolute path instead of `..` chains.
  if (relative === '..' || relative.startsWith('../')) {
    return path.isAbsolute(absPath) ? absPath.replace(/\\/g, '/') : relative;
  }
  return relative;
}

/**
 * Listings hide only what the session's sandbox still denies. Segment names such
 * as `.env`, `.git`, `.ssh`, `node_modules`, `dist` and `build` are no longer
 * restricted; only the remaining blocked extensions are, and unrestricted
 * sessions hide nothing.
 */
export function isWorkspaceEntryVisible(name: string, sessionId?: string | null): boolean {
  const config = sandboxConfigForSession(sessionId ?? '__default__');
  if (config.unrestricted) return true;
  const ext = path.extname(name).toLowerCase();
  return !(ext && config.blockedExtensions.has(ext));
}

export function isWorkspaceRelativePathBlocked(relativePath: string, sessionId?: string | null): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.') return false;
  return !isWorkspaceEntryVisible(path.posix.basename(normalized), sessionId);
}
