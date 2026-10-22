import fs from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

export const SEARCH_TIMEOUT_MS = 30_000;
export const SEARCH_MAX_FILE_BYTES = 256_000;
export const SEARCH_MAX_ENTRIES = 50_000;
export type SearchCompletion = "complete" | "limit_reached" | "timeout" | "cancelled";
export interface SearchBudget {
  deadline: number;
  signal?: AbortSignal;
  entries: number;
  files: number;
  bytes: number;
  status: SearchCompletion;
}
export function searchCanContinue(budget: SearchBudget): boolean {
  if (budget.signal?.aborted) budget.status = "cancelled";
  else if (Date.now() >= budget.deadline) budget.status = "timeout";
  else if (budget.entries >= SEARCH_MAX_ENTRIES || budget.bytes >= 64 * 1024 * 1024) budget.status = "limit_reached";
  return budget.status === "complete";
}
export function matchesSearchGlob(file: string, pattern: string): boolean {
  const matcher = ignore().add(pattern);
  return matcher.ignores(file.replaceAll(path.sep, "/"));
}
type Scope = { root: string; rules: Ignore };
const defaults = ignore().add([".git/", "node_modules/", "target/", "dist/", "server-dist/", "dist-electron/", ".DS_Store"]);

/** Filters before descending, never follows symlinks, and yields to cancellation on each entry. */
export async function* searchFiles(base: string, workspace: string, budget: SearchBudget,
  options: { filePattern?: string; excludePattern?: string; includeIgnored?: boolean } = {}): AsyncGenerator<string> {
  const load = async (root: string): Promise<Scope> => {
    const rules = ignore();
    if (!options.includeIgnored) for (const name of [".gitignore", ".ignore", ".rgignore"]) {
      try {
        const file = path.join(root, name);
        const stat = await fs.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= SEARCH_MAX_FILE_BYTES) rules.add(await fs.readFile(file, "utf8"));
      } catch { /* missing/unreadable ignore files */ }
    }
    return { root, rules };
  };
  const ancestors: Scope[] = [];
  const relative = path.relative(workspace, base);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    let root = workspace;
    ancestors.push(await load(root));
    for (const segment of relative.split(path.sep).slice(0, -1)) {
      root = path.join(root, segment); ancestors.push(await load(root));
    }
  }
  async function* walk(directory: string, scopes: Scope[], depth: number): AsyncGenerator<string> {
    if (!searchCanContinue(budget)) return;
    if (depth > 64) { budget.status = "limit_reached"; return; }
    scopes = [...scopes, await load(directory)];
    let dir;
    try { dir = await fs.opendir(directory); } catch { return; }
    for await (const entry of dir) {
      if (!searchCanContinue(budget)) return;
      budget.entries++;
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) continue;
      const full = path.join(directory, entry.name);
      const rel = path.relative(base, full).split(path.sep).join("/");
      const candidate = rel + (entry.isDirectory() ? "/" : "");
      if (entry.name === ".git" || entry.name === ".DS_Store") continue;
      if (options.excludePattern && matchesSearchGlob(candidate, options.excludePattern)) continue;
      if (!options.includeIgnored) {
        let ignored = defaults.ignores(candidate) || entry.name.startsWith(".");
        for (const scope of scopes) {
          const value = scope.rules.test(path.relative(scope.root, full).split(path.sep).join("/") + (entry.isDirectory() ? "/" : ""));
          if (value.ignored) ignored = true;
          else if (value.unignored) ignored = false;
        }
        if (ignored) continue;
      }
      if (entry.isDirectory()) { yield* walk(full, scopes, depth + 1); continue; }
      if (options.filePattern && !matchesSearchGlob(rel, options.filePattern)) continue;
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > SEARCH_MAX_FILE_BYTES) continue;
      budget.files++; budget.bytes += stat.size;
      yield full;
    }
  }
  yield* walk(base, ancestors, 0);
}
