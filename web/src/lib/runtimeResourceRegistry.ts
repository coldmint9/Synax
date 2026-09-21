/**
 * Client-side record of runtime resources being removed or confirmed missing.
 *
 * Deleting a session tears down a whole tree, while the UI regularly fans out
 * several parallel requests per session (a detail refresh alone issues nine).
 * Those requests cannot be cancelled once dispatched, so responses describing a
 * row the user just deleted arrive as `404 NOT_FOUND` and would otherwise be
 * reported as a failure the user did not experience.
 *
 * Callers register the ids they are deleting here and the error router consults
 * it before surfacing a missing-resource message. Ids are registered by an
 * explicit removal or an authoritative session `NOT_FOUND` response;
 * unrelated missing-resource errors keep their normal treatment.
 */
const MAX_TRACKED_RESOURCES = 512

const pendingRemovals = new Set<string>()
const removedResources = new Set<string>()

/** Insertion-ordered, oldest first, so the cap drops the stalest id. */
function remember(set: Set<string>, id: string): void {
  set.delete(id)
  set.add(id)
  while (set.size > MAX_TRACKED_RESOURCES) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

export function markRuntimeResourcePendingRemoval(id: string): void {
  remember(pendingRemovals, id)
}

export function clearRuntimeResourcePendingRemoval(id: string): void {
  pendingRemovals.delete(id)
}

export function isRuntimeResourcePendingRemoval(id: string): boolean {
  return pendingRemovals.has(id)
}

export function markRuntimeResourcesRemoved(ids: Iterable<string>): void {
  for (const id of ids) {
    pendingRemovals.delete(id)
    remember(removedResources, id)
  }
}

export function isRuntimeResourceRemoved(id: string): boolean {
  return removedResources.has(id)
}

/** True when the id must not be reported as an unexpected failure. */
export function isRuntimeResourceGone(id: string): boolean {
  return removedResources.has(id) || pendingRemovals.has(id)
}

export function resetRuntimeResourceRegistryForTests(): void {
  pendingRemovals.clear()
  removedResources.clear()
}
