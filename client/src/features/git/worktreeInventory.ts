import { projectApi, type GitWorkspaceSummary } from '../../adapters/transport/project';

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: GitWorkspaceSummary }>();
const requests = new Map<string, Promise<GitWorkspaceSummary>>();
const keyFor = (projectId: string, rootId?: string) => JSON.stringify([projectId, rootId ?? projectId]);
export const WORKTREES_CHANGED = 'git:worktrees-changed';

export function cachedWorktreeInventory(projectId: string, rootId?: string) {
  return cache.get(keyFor(projectId, rootId))?.value;
}

/** Cheap inventory only: status and occupancy are checked on destructive actions. */
export function loadWorktreeInventory(projectId: string, rootId?: string, force = false) {
  const key = keyFor(projectId, rootId);
  const current = cache.get(key);
  if (!force && current && Date.now() - current.at < CACHE_MS) return Promise.resolve(current.value);
  const pending = requests.get(key);
  if (pending) return pending;
  const request: Promise<GitWorkspaceSummary> = projectApi.listGitWorkspaces(projectId, rootId, 'inventory').then(value => {
    if (requests.get(key) !== request) return loadWorktreeInventory(projectId, rootId);
    if (requests.get(key) === request) {
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 256) cache.delete(cache.keys().next().value!);
    }
    return value;
  }).finally(() => { if (requests.get(key) === request) requests.delete(key); });
  requests.set(key, request);
  return request;
}

export function invalidateWorktreeInventory(projectId: string, rootId?: string) {
  const key = keyFor(projectId, rootId);
  cache.delete(key);
  requests.delete(key);
  document.dispatchEvent(new CustomEvent(WORKTREES_CHANGED, { detail: { projectId, rootId } }));
}
