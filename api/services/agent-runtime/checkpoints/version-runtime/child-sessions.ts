import { agentRuntimeStore, type AgentRuntimeStore } from "../../session-store.js";
import { logger } from "../../../../lib/logger.js";

/** Archivable sessions created at/after the boundary. A versioned root keeps
 *  `childSessionIds` in its live row while its versioned transcript stays
 *  child-agnostic, so a rollback to an older revision leaves children spawned in
 *  the discarded branch referencing messages that no longer exist. Those
 *  children are archived as their own recoverable batch (their `archive_batch_id`
 *  is the child itself, so the ordinary archive listing/restore flow keeps
 *  working) instead of lingering in the tree as orphans.
 *
 *  Children created before the boundary stay: the retained transcript still
 *  references them. Comparisons are inclusive at the boundary (a child created in
 *  the same millisecond as the checkpoint counts as discarded) because a stale
 *  child is recoverable while a restored one is not. An unparsable boundary skips
 *  the pass entirely: uncertainty must never delete history.
 *
 *  `listSessionTree` only returns non-archived members, so a repeated rollback of
 *  the same boundary re-archives nothing. */
export function archiveChildrenBeyondBoundary(
  sessionId: string,
  boundaryCreatedAt: string,
  store: AgentRuntimeStore = agentRuntimeStore,
): string[] {
  const boundary = Date.parse(boundaryCreatedAt);
  if (!Number.isFinite(boundary)) {
    logger.warn(
      { sessionId, boundaryCreatedAt },
      "[child-sessions] unparsable history boundary; skipping child archival",
    );
    return [];
  }
  const archived: string[] = [];
  for (const child of store.listSessionTree(sessionId)) {
    if (child.parentSessionId !== sessionId) continue;
    const created = Date.parse(child.createdAt);
    if (Number.isFinite(created) && created < boundary) continue;
    for (const childId of store.archiveSessionTree(child.id).archivedSessionIds)
      archived.push(childId);
  }
  return archived;
}
