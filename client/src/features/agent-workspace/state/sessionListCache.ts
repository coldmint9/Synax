import type { AgentSession } from "../../../adapters/transport/agentRuntime";

/**
 * Painted session lists for workspaces the user is not currently inside.
 *
 * Switching workspaces used to drop the list and fetch it again, so every
 * switch painted an empty loading skeleton and waited for a round trip. A
 * workspace now keeps its last painted rows, cursor and total in memory, so a
 * return visit renders them synchronously and only reconciles in the background
 * once the snapshot is stale.
 *
 * Invariants:
 * - Rows are already filtered by `isRuntimeResourceGone`, so a restored list
 *   never shows a session the runtime reported as removed.
 * - Snapshots are memory-only. Transcripts have their own persisted tier; a
 *   list is cheap to rebuild after a process start and gains nothing from disk.
 */

export interface SessionListSnapshot {
  sessions: AgentSession[];
  total: number | null;
  offset: number;
  /** Local time the rows were last confirmed by the runtime. */
  loadedAt: number;
}

/** A return visit inside this window paints from memory without any request. */
export const SESSION_LIST_FRESH_MS = 60_000;
/** Workspaces remembered at once; the least recently visited one is dropped. */
export const REMEMBERED_SESSION_LISTS = 8;

const snapshots = new Map<string, SessionListSnapshot>();
/**
 * Workspaces whose snapshot was purged. The switch away from a removed
 * workspace still parks its rows, so exactly one later write is dropped; the
 * next real read is remembered again.
 */
const purged = new Set<string>();

export function isSessionListFresh(
  loadedAt: number,
  ttl = SESSION_LIST_FRESH_MS,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(loadedAt) || loadedAt <= 0) return false;
  const age = now - loadedAt;
  return age >= 0 && age < ttl;
}

export function rememberSessionList(
  projectId: string | null | undefined,
  snapshot: SessionListSnapshot,
): void {
  if (!projectId) return;
  if (!Number.isFinite(snapshot.loadedAt) || snapshot.loadedAt <= 0) return;
  if (purged.delete(projectId)) return;
  // Re-insert so Map iteration order stays least-recently-visited first.
  snapshots.delete(projectId);
  snapshots.set(projectId, snapshot);
  while (snapshots.size > REMEMBERED_SESSION_LISTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

/** Render-time read: never reorders the cache. */
export function peekSessionList(
  projectId: string | null | undefined,
): SessionListSnapshot | null {
  if (!projectId) return null;
  return snapshots.get(projectId) ?? null;
}

/** Switch-time read that also marks the workspace most recently visited. */
export function recallSessionList(
  projectId: string | null | undefined,
): SessionListSnapshot | null {
  const snapshot = peekSessionList(projectId);
  if (snapshot && projectId) {
    snapshots.delete(projectId);
    snapshots.set(projectId, snapshot);
  }
  return snapshot;
}

export function forgetSessionList(projectId: string | null | undefined): void {
  if (!projectId) return;
  snapshots.delete(projectId);
  purged.add(projectId);
}

function replaceRows(
  projectId: string,
  snapshot: SessionListSnapshot,
  sessions: AgentSession[],
): void {
  snapshots.set(projectId, { ...snapshot, sessions });
}

/** Apply a live patch (or any row rewrite) to remembered lists. */
export function updateSessionListRows(
  update: (session: AgentSession) => AgentSession | null,
): void {
  for (const [projectId, snapshot] of [...snapshots]) {
    let changed = false;
    const sessions = snapshot.sessions.map((session) => {
      const next = update(session);
      if (!next || next === session) return session;
      changed = true;
      return next;
    });
    if (changed) replaceRows(projectId, snapshot, sessions);
  }
}

/** Drop rows the runtime reported as removed or archived. */
export function forgetSessionsFromLists(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return;
  const removed = new Set(sessionIds);
  for (const [projectId, snapshot] of [...snapshots]) {
    const sessions = snapshot.sessions.filter(
      (session) => !removed.has(session.id),
    );
    if (sessions.length === snapshot.sessions.length) continue;
    replaceRows(projectId, snapshot, sessions);
  }
}

/** Test seam: forget every remembered workspace. */
export function resetSessionListCache(): void {
  snapshots.clear();
  purged.clear();
}

/** Test seam: inspect remembered workspaces in visit order. */
export function rememberedSessionListIds(): string[] {
  return [...snapshots.keys()];
}
