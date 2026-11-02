import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A machine already holding the repository is the cheapest clone there is, so
 * workspace provisioning asks this module before it asks git. The scan reads
 * `remote` URLs out of `.git/config` instead of running git once per directory:
 * only the winning candidate is validated with git itself.
 */

/** How deep a scan root is walked; project roots are rarely nested deeper. */
const DEFAULT_MAX_DEPTH = 3;
/** A scan must never stall provisioning, so both limits are best-effort cut-offs. */
const DEFAULT_MAX_REPOS = 400;
const DEFAULT_BUDGET_MS = 5_000;
/** Build output never contains a project root and is expensive to walk. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "vendor", "target", "build", "dist", "Pods"]);

export interface GitRunResult {
  stdout: string;
  stderr?: string;
}

/** Injected in tests; production runs the local `git`. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

export interface LocalCloneMatch {
  /** Repository root, absolute. */
  path: string;
  /** The remote URL exactly as that clone records it. */
  repoUrl: string;
  /** `false` when the working tree has uncommitted changes. */
  clean: boolean;
}

export interface FindLocalCloneInput {
  /** The repository to look for, as the workspace registered it. */
  repoUrl: string;
  /** Only used to prefer a directory named after the project. */
  preferredName?: string;
  roots?: string[];
  maxDepth?: number;
  maxRepos?: number;
  budgetMs?: number;
  run?: GitRunner;
  now?(): number;
}

/**
 * Where a clone of a managed project is normally kept on a developer machine.
 *
 * `SYNAX_LOCAL_CLONE_ROOTS` (path-delimited) replaces the whole list, so a
 * machine with an unusual layout does not need a code change.
 */
export function localCloneRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.SYNAX_LOCAL_CLONE_ROOTS ?? "")
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  // `homedir()` follows HOME, which a sandboxed runtime redirects; the clones
  // developers care about live under the account's real home.
  const home = realHomeDirectory();
  return ["IdeaProjects", "Projects", "projects", "workspace", "Workspace", "code", "Code", "git", "dev", "Documents/GitHub"]
    .map(name => path.join(home, name));
}

function realHomeDirectory(): string {
  try {
    return userInfo().homedir || homedir();
  } catch {
    return homedir();
  }
}

/**
 * Reduces every clone-URL form of one repository to a single comparison key.
 *
 * `https://gitlab.test/group/repo.git`, `git@gitlab.test:group/repo` and
 * `ssh://git@gitlab.test/group/repo` all describe the same repository, and a
 * developer machine mixes all three. Case is folded because a host that ignores
 * case for project paths (GitLab) would otherwise report a false miss.
 */
export function normalizeRepoUrl(repoUrl: string): string | null {
  const raw = repoUrl.trim();
  if (!raw) return null;
  let host: string;
  let pathname: string;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(raw);
  if (scp) {
    host = scp[1];
    pathname = scp[2];
  } else {
    try {
      const parsed = new URL(raw);
      if (!parsed.hostname) return null;
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      // `git clone` also accepts a bare `host/group/repo`.
      const bare = /^([^/\s:.]+\.[^/\s:]+)\/(.+)$/.exec(raw);
      if (!bare) return null;
      host = bare[1];
      pathname = bare[2];
    }
  }
  const segments = pathname.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
  const normalizedHost = host.toLowerCase().replace(/^www\./, "");
  return segments.length ? `${normalizedHost}/${segments.join("/")}` : normalizedHost;
}

/** Remote URLs declared in one `config` file, in declaration order. */
export function parseRemoteUrls(config: string): string[] {
  const urls: string[] = [];
  let inRemote = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      inRemote = /^remote\b/i.test(section[1].trim());
      continue;
    }
    if (!inRemote) continue;
    const url = /^\s*url\s*=\s*(.+)$/i.exec(line)?.[1]?.trim();
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * Reads the remote URLs of one repository root.
 *
 * A linked worktree keeps only a `gitdir:` pointer in `.git`, and its remotes
 * live in the main clone's config; following the pointer keeps worktrees
 * usable as a match instead of reporting them as "not a repository".
 */
export async function readRemoteUrls(repoDir: string): Promise<string[]> {
  const configPath = await gitConfigPath(repoDir);
  if (!configPath) return [];
  const content = await readFile(configPath, "utf8").catch(() => "");
  return parseRemoteUrls(content);
}

async function gitConfigPath(repoDir: string): Promise<string | null> {
  const dotGit = path.join(repoDir, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (!info) return null;
  if (info.isDirectory()) return path.join(dotGit, "config");
  if (!info.isFile()) return null;
  const pointer = await readFile(dotGit, "utf8").catch(() => "");
  const target = /^gitdir:\s*(.+)$/im.exec(pointer)?.[1]?.trim();
  if (!target) return null;
  const gitDir = path.resolve(repoDir, target);
  const parent = path.dirname(gitDir);
  return path.basename(parent) === "worktrees" ? path.join(path.dirname(parent), "config") : path.join(gitDir, "config");
}

/**
 * Finds an existing clone of `repoUrl` on this machine.
 *
 * Only directories that record a matching remote count as a hit — a directory
 * that merely shares the project's name is not evidence of a clone. The scan is
 * bounded by depth, repository count and wall clock; an exhausted budget
 * returns the best hit found so far rather than failing the caller.
 */
export async function findLocalClone(input: FindLocalCloneInput): Promise<LocalCloneMatch | null> {
  const wanted = normalizeRepoUrl(input.repoUrl);
  if (!wanted) return null;
  const roots = [...new Set((input.roots ?? localCloneRoots()).filter(Boolean))];
  if (!roots.length) return null;

  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxRepos = input.maxRepos ?? DEFAULT_MAX_REPOS;
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? DEFAULT_BUDGET_MS);
  const matches: Array<{ path: string; repoUrl: string }> = [];
  const queue = roots.map(root => ({ dir: root, depth: 0 }));

  while (queue.length) {
    if (matches.length >= maxRepos || now() > deadline) break;
    const { dir, depth } = queue.shift()!;
    const remotes = await readRemoteUrls(dir).catch(() => []);
    if (remotes.length) {
      const match = remotes.find(remote => normalizeRepoUrl(remote) === wanted);
      if (match) matches.push({ path: dir, repoUrl: match });
      // A repository is not a container of unrelated projects.
      continue;
    }
    if (depth >= maxDepth) continue;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  if (!matches.length) return null;

  const preferred = input.preferredName?.trim().toLowerCase();
  const ranked = [...matches].sort((a, b) => {
    const byName = Number(path.basename(b.path).toLowerCase() === preferred) - Number(path.basename(a.path).toLowerCase() === preferred);
    return byName || a.path.length - b.path.length;
  });
  const run = input.run ?? defaultGitRunner;
  for (const candidate of ranked) {
    if (await isCleanWorkTree(candidate.path, run)) return { ...candidate, clean: true };
  }
  // Nothing reusable, but the caller can still tell the user where it looked.
  return { ...ranked[0], clean: false };
}

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { stdout, stderr };
};

async function isCleanWorkTree(repoPath: string, run: GitRunner): Promise<boolean> {
  try {
    const { stdout } = await run(["status", "--porcelain"], repoPath);
    return stdout.trim() === "";
  } catch {
    // An unreadable repository is not safe to reuse.
    return false;
  }
}
