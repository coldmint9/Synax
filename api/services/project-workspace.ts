import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../lib/env.js';

export interface ProjectReference {
  id: string;
  name: string;
  localPath: string;
}

export interface WorkspaceProject {
  id: string;
  name?: string;
  source?: { localPath?: string };
  references?: ProjectReference[];
}

export interface ProjectWorkspaceRoot {
  id: string;
  name: string;
  path: string;
  role: 'primary' | 'reference';
  status: 'available' | 'missing';
}

export function canonicalWorkspaceDirectory(input: string): string {
  if (!path.isAbsolute(input) || input.includes('\0')) throw new Error('Workspace directory must be an absolute path.');
  try {
    const resolved = fs.realpathSync(input);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('Not a directory');
    return resolved;
  } catch {
    throw new Error(`Workspace directory is unavailable: ${input}`);
  }
}

export function isWithinWorkspace(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function projectWorkspaceRoots(project: WorkspaceProject): ProjectWorkspaceRoot[] {
  const roots: Omit<ProjectWorkspaceRoot, 'status'>[] = [];
  if (project.source?.localPath) roots.push({ id: project.id, name: project.name ?? project.id, path: project.source.localPath, role: 'primary' });
  for (const reference of project.references ?? []) {
    roots.push({ id: reference.id, name: reference.name, path: reference.localPath, role: 'reference' });
  }
  return roots.map(root => {
    try { return { ...root, path: canonicalWorkspaceDirectory(root.path), status: 'available' }; }
    catch { return { ...root, status: 'missing' }; }
  });
}

export function readWorkspaceProject(projectId: string): WorkspaceProject | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'projects.json'), 'utf8'));
    const items: WorkspaceProject[] = Array.isArray(raw) ? raw : raw.items ?? [];
    return items.find(project => project.id === projectId);
  } catch { return undefined; }
}

/** References are direct directory memberships, never recursive project imports. */
export function validateProjectReference(project: WorkspaceProject, input: string): string {
  if (!project.source?.localPath) throw new Error('The main project must have a local workspace before adding references.');
  canonicalWorkspaceDirectory(project.source.localPath);
  const candidate = canonicalWorkspaceDirectory(input);
  for (const root of projectWorkspaceRoots(project)) {
    const existing = path.resolve(root.path);
    if (isWithinWorkspace(existing, candidate) || isWithinWorkspace(candidate, existing)) {
      throw new Error(`Workspace directories must not duplicate or overlap: ${root.name}`);
    }
  }
  return candidate;
}
