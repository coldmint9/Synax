import fs from 'node:fs';
import path from 'node:path';
import { assertLinuxAbsolutePath, assertWslDistributionName, canonicalizeWslPath } from './wsl.js';

export type WorkspaceLocation =
  | { kind: 'host'; path: string }
  | { kind: 'wsl'; distribution: string; path: string };

export function hostWorkspaceLocation(input: string): WorkspaceLocation {
  return { kind: 'host', path: input };
}

export function workspaceLocationDisplay(location: WorkspaceLocation): string {
  return location.kind === 'wsl' ? `${location.distribution} · ${location.path}` : location.path;
}

export function wslUncRoot(distribution: string): string {
  distribution = assertWslDistributionName(distribution);
  return `\\\\wsl.localhost\\${distribution}`;
}

export function workspaceLocationHostPath(location: WorkspaceLocation): string {
  if (location.kind === 'host') return location.path;
  const linuxPath = assertLinuxAbsolutePath(location.path);
  const suffix = linuxPath === '/' ? '' : linuxPath.split('/').filter(Boolean).join('\\');
  return suffix ? `${wslUncRoot(location.distribution)}\\${suffix}` : wslUncRoot(location.distribution);
}

export function parseWslUncPath(input: string): Extract<WorkspaceLocation, { kind: 'wsl' }> | null {
  const normalized = input.replace(/\//g, '\\');
  const match = normalized.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i);
  if (!match) return null;
  const linuxPath = `/${(match[2] ?? '').split('\\').filter(Boolean).join('/')}`;
  return { kind: 'wsl', distribution: match[1], path: path.posix.normalize(linuxPath) };
}

export function canonicalHostDirectory(input: string): string {
  if (!path.isAbsolute(input) || input.includes('\0')) throw new Error('Workspace directory must be an absolute path.');
  try {
    const resolved = fs.realpathSync(input);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('Not a directory');
    return resolved;
  } catch {
    throw new Error(`Workspace directory is unavailable: ${input}`);
  }
}

export async function canonicalizeWorkspaceLocation(location: WorkspaceLocation): Promise<WorkspaceLocation> {
  if (location.kind === 'host') return { kind: 'host', path: canonicalHostDirectory(location.path) };
  return { kind: 'wsl', distribution: location.distribution, path: await canonicalizeWslPath(location.distribution, location.path) };
}

export function canonicalizeWorkspaceLocationSync(location: WorkspaceLocation): WorkspaceLocation {
  if (location.kind === 'host') return { kind: 'host', path: canonicalHostDirectory(location.path) };
  const pathValue = assertLinuxAbsolutePath(location.path);
  const hostPath = workspaceLocationHostPath({ ...location, path: pathValue });
  try {
    const info = fs.statSync(hostPath);
    if (!info.isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new Error(`Workspace directory is unavailable: ${workspaceLocationDisplay(location)}`);
  }
  return { kind: 'wsl', distribution: location.distribution, path: pathValue };
}

export function locationKey(location: WorkspaceLocation): string {
  if (location.kind === 'wsl') return `wsl:${location.distribution.toLocaleLowerCase()}:${path.posix.normalize(location.path)}`;
  const normalized = path.normalize(path.resolve(location.path));
  return `host:${process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized}`;
}

export function physicalLocationKey(location: WorkspaceLocation): string {
  if (location.kind === 'wsl') {
    const mounted = path.posix.normalize(location.path).match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
    if (mounted) {
      const windowsPath = `${mounted[1].toUpperCase()}:\\${(mounted[2] ?? '').replace(/\//g, '\\')}`;
      return `host:${path.win32.normalize(windowsPath).toLocaleLowerCase()}`;
    }
    return locationKey(location);
  }
  if (/^[a-zA-Z]:[\\/]/.test(location.path)) {
    return `host:${path.win32.normalize(location.path).toLocaleLowerCase()}`;
  }
  return locationKey(location);
}

export function sameExecutionEnvironment(left: WorkspaceLocation, right: WorkspaceLocation): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'host' || left.distribution.toLocaleLowerCase() === (right as Extract<WorkspaceLocation, { kind: 'wsl' }>).distribution.toLocaleLowerCase();
}

export function assertCompatibleLocations(locations: WorkspaceLocation[]): void {
  if (locations.length < 2) return;
  const first = locations[0];
  for (const location of locations.slice(1)) {
    if (first.kind !== location.kind) throw new Error('Workspace roots must use the same environment.');
    if (first.kind === 'wsl' && location.kind === 'wsl' && first.distribution.toLocaleLowerCase() !== location.distribution.toLocaleLowerCase()) {
      throw new Error('Workspace roots must use the same WSL distribution.');
    }
  }
}

export function locationContains(root: WorkspaceLocation, target: WorkspaceLocation): boolean {
  if (!sameExecutionEnvironment(root, target)) return false;
  const pathApi = root.kind === 'wsl' ? path.posix : path;
  const relative = pathApi.relative(root.path, target.path);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

export function workspaceLocationRelative(root: WorkspaceLocation, target: WorkspaceLocation): string {
  if (!sameExecutionEnvironment(root, target)) throw new Error('Workspace locations use different execution environments.');
  return (root.kind === 'wsl' ? path.posix : path).relative(root.path, target.path);
}

export function resolveWorkspaceLocation(root: WorkspaceLocation, input: string): WorkspaceLocation {
  if (root.kind === 'wsl') return { ...root, path: path.posix.resolve(root.path, input.replace(/\\/g, '/')) };
  return { kind: 'host', path: path.resolve(root.path, input) };
}
