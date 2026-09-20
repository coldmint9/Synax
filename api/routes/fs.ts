import { Hono } from 'hono';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import * as z from 'zod/v4';
import { logger } from '../lib/logger.js';
import { canonicalizeWslPath, WslError, wslHomeDirectory } from '../services/wsl.js';
import { workspaceLocationHostPath } from '../services/workspace-location.js';

// ---------------------------------------------------------------------------
// Host directory browsing.
//
// The browser build cannot obtain a local directory path from the renderer, so
// the runtime host lists directories on the user's behalf and the client sends
// back the picked absolute path. The runtime is single-user and loopback-only
// (see middleware/runtime-access.ts), so this mirrors the reach of the desktop
// directory dialog: directories are listed, file contents are never returned.
// ---------------------------------------------------------------------------

/** Dotfiles and build/VCS noise stay hidden unless the caller opts in. */
const HIDDEN_ENTRY = /^\./;
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'server-dist', 'dist-electron', 'target']);
const MAX_ENTRIES = 2000;

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  name: string;
  parent: string | null;
  home: string;
  shortcuts: string[];
  entries: DirectoryEntry[];
  truncated: boolean;
}

export class DirectoryBrowseError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 500) {
    super(message);
    this.name = 'DirectoryBrowseError';
  }
}

const listQuerySchema = z.object({
  path: z.string().max(4096).optional(),
  locationKind: z.enum(['host', 'wsl']).optional(),
  distribution: z.string().max(256).optional(),
  showHidden: z.string().optional(),
  showIgnored: z.string().optional(),
});

const flag = (value?: string) => value === '1' || value === 'true';

/**
 * Resolve a user-supplied directory path to a canonical absolute path.
 * Symlinks are followed; anything that is not an existing absolute directory is
 * rejected so the picker never advertises a path the runtime cannot use.
 */
export async function resolveBrowseDirectory(input?: string): Promise<string> {
  const raw = input?.trim() || homedir();
  if (!isAbsolute(raw)) throw new DirectoryBrowseError('Directory path must be absolute.', 400);
  const candidate = resolve(raw);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new DirectoryBrowseError(`Directory not found: ${candidate}`, 404);
    if (code === 'EACCES' || code === 'EPERM') throw new DirectoryBrowseError(`Directory is not readable: ${candidate}`, 403);
    throw new DirectoryBrowseError(`Directory is unavailable: ${candidate}`, 400);
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new DirectoryBrowseError('Path is not a directory.', 400);
  return canonical;
}

/** Places worth one click from anywhere. Only existing entries are offered. */
async function shortcutsFor(current: string): Promise<string[]> {
  const candidates = process.platform === 'darwin' ? [homedir(), dirname(homedir()), '/Volumes', '/tmp'] : [homedir(), dirname(homedir()), '/tmp'];
  const unique = [...new Set(candidates)];
  const checks = await Promise.all(unique.map(async candidate => {
    if (candidate === current) return null;
    try {
      return (await stat(candidate)).isDirectory() ? candidate : null;
    } catch {
      return null;
    }
  }));
  return checks.filter((entry): entry is string => entry !== null);
}

/**
 * List child directories of `input`. Unreadable children are skipped rather
 * than failing the whole listing: the browser must still navigate past
 * root-owned entries inside a home directory.
 */
export async function listDirectories(
  input?: string,
  options?: { showHidden?: boolean; showIgnored?: boolean },
): Promise<DirectoryListing> {
  const canonical = await resolveBrowseDirectory(input);
  let dirents;
  try {
    dirents = await readdir(canonical, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new DirectoryBrowseError(`Directory is not readable: ${canonical}`, 403);
    throw new DirectoryBrowseError(`Directory is unavailable: ${canonical}`, 400);
  }

  const showHidden = options?.showHidden === true;
  const showIgnored = options?.showIgnored === true;
  const visible = dirents
    .filter(dirent => dirent.isDirectory() || dirent.isSymbolicLink())
    .map(dirent => dirent.name)
    .filter(name => (showHidden || !HIDDEN_ENTRY.test(name)) && (showIgnored || !IGNORED_DIRECTORIES.has(name)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));

  const truncated = visible.length > MAX_ENTRIES;
  const entries = await filterDirectories(canonical, truncated ? visible.slice(0, MAX_ENTRIES) : visible);

  return {
    path: canonical,
    name: basename(canonical) || canonical,
    parent: parentOf(canonical),
    home: homedir(),
    shortcuts: await shortcutsFor(canonical),
    entries,
    truncated,
  };
}

export async function listWslDirectories(
  distribution: string,
  input?: string,
  options?: { showHidden?: boolean; showIgnored?: boolean },
): Promise<DirectoryListing> {
  const home = await wslHomeDirectory(distribution);
  const canonical = await canonicalizeWslPath(distribution, input?.trim() || home);
  const location = { kind: 'wsl' as const, distribution, path: canonical };
  const hostPath = workspaceLocationHostPath(location);
  let dirents;
  try {
    dirents = await readdir(hostPath, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new DirectoryBrowseError(`Directory is not readable: ${canonical}`, 403);
    throw new DirectoryBrowseError(`Directory is unavailable: ${canonical}`, 400);
  }
  const showHidden = options?.showHidden === true;
  const showIgnored = options?.showIgnored === true;
  const visible = dirents
    .filter(dirent => dirent.isDirectory() || dirent.isSymbolicLink())
    .map(dirent => dirent.name)
    .filter(name => (showHidden || !HIDDEN_ENTRY.test(name)) && (showIgnored || !IGNORED_DIRECTORIES.has(name)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const truncated = visible.length > MAX_ENTRIES;
  const names = truncated ? visible.slice(0, MAX_ENTRIES) : visible;
  const entries = (await Promise.all(names.map(async name => {
    const linuxPath = path.posix.join(canonical, name);
    try {
      if (!(await stat(workspaceLocationHostPath({ kind: 'wsl', distribution, path: linuxPath }))).isDirectory()) return null;
    } catch { return null; }
    return { name, path: linuxPath, hidden: HIDDEN_ENTRY.test(name) } satisfies DirectoryEntry;
  }))).filter((entry): entry is DirectoryEntry => entry !== null);
  const shortcutCandidates = [home, '/', '/mnt'].filter(candidate => candidate !== canonical);
  const shortcuts = (await Promise.all(shortcutCandidates.map(async candidate => {
    try {
      return (await stat(workspaceLocationHostPath({ kind: 'wsl', distribution, path: candidate }))).isDirectory() ? candidate : null;
    } catch { return null; }
  }))).filter((entry): entry is string => entry !== null);
  return {
    path: canonical,
    name: path.posix.basename(canonical) || canonical,
    parent: canonical === '/' ? null : path.posix.dirname(canonical),
    home,
    shortcuts: [...new Set(shortcuts)],
    entries,
    truncated,
  };
}

/** Keep only entries that really are directories once symlinks are followed. */
async function filterDirectories(parent: string, names: string[]): Promise<DirectoryEntry[]> {
  const results = await Promise.all(names.map(async name => {
    const absolute = join(parent, name);
    try {
      if (!(await stat(absolute)).isDirectory()) return null;
    } catch {
      return null;
    }
    return { name, path: absolute, hidden: HIDDEN_ENTRY.test(name) } satisfies DirectoryEntry;
  }));
  return results.filter((entry): entry is DirectoryEntry => entry !== null);
}

function parentOf(canonical: string): string | null {
  const parent = dirname(canonical);
  return parent === canonical ? null : parent;
}

export const fsRoutes = new Hono();

fsRoutes.get('/list', async c => {
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  try {
    const options = {
      showHidden: flag(parsed.data.showHidden),
      showIgnored: flag(parsed.data.showIgnored),
    };
    const listing = parsed.data.locationKind === 'wsl'
      ? await listWslDirectories(parsed.data.distribution ?? '', parsed.data.path, options)
      : await listDirectories(parsed.data.path, options);
    return c.json(listing);
  } catch (error) {
    if (error instanceof WslError) {
      return c.json({ error: error.message, code: error.code }, error.code === 'WSL_DISTRIBUTION_MISSING' ? 404 : 400);
    }
    if (error instanceof DirectoryBrowseError) {
      return c.json({ error: error.message, code: 'DIRECTORY_UNAVAILABLE' }, error.status);
    }
    logger.error({ err: error instanceof Error ? error.message : String(error) }, '[fs] directory listing failed');
    return c.json({ error: 'Directory listing failed.' }, 500);
  }
});
