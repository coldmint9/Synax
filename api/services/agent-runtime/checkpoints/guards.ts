import { activeWorkspaceSessions, openWriterRoots } from "./lock-pages.js";
import {
  versionRepository,
  versionedSession,
} from "./version-runtime/bridge.js";
import fs from "node:fs";
import path from "node:path";
import { getRawSqlite } from "../../../db/index.js";
import { AgentRuntimeError } from "../runtime-errors.js";
import { agentRuntimeStore } from "../session-store.js";
import { resolveSessionWorkspaceRoots } from "../tools/workspace.js";
import { workspaceLocationHostPath } from "../../workspace-location.js";

export const activeHistoryOperations = new Set<string>();
export const historyError = (message: string, code = "HISTORY_CONFLICT") =>
  new AgentRuntimeError(message, code, 409);
export function historyRevision(sessionId: string): number {
  if (versionedSession(sessionId))
    return versionRepository().head(sessionId).revision;
  return (
    (
      getRawSqlite()
        .prepare(
          "SELECT revision FROM conversation_history_versions WHERE session_id=?",
        )
        .get(sessionId) as { revision: number } | undefined
    )?.revision ?? 0
  );
}
export function historyEpoch(sessionId: string): number {
  return versionedSession(sessionId)
    ? versionRepository().head(sessionId).epoch
    : historyRevision(sessionId);
}
export function rootOwner(sessionId: string): string {
  const seen = new Set<string>();
  let current = agentRuntimeStore.getSession(sessionId);
  while (current.parentSessionId && !seen.has(current.id)) {
    seen.add(current.id);
    current = agentRuntimeStore.getSession(current.parentSessionId);
  }
  return current.id;
}
export function sessionRoots(sessionId: string): string[] {
  const session = agentRuntimeStore.getSession(sessionId);
  const roots = resolveSessionWorkspaceRoots(sessionId, session.projectId);
  const canonicalRoots = [
    ...new Set(
      roots.map((root) => {
        if (root.status !== "available")
          throw historyError(`Workspace ${root.name} is unavailable.`);
        return fs.realpathSync(
          root.location ? workspaceLocationHostPath(root.location) : root.path,
        );
      }),
    ),
  ];
  return canonicalRoots.filter(
    (root) =>
      !canonicalRoots.some(
        (parent) => parent !== root && root.startsWith(`${parent}${path.sep}`),
      ),
  );
}
export function rootsOverlap(a: string, b: string): boolean {
  const relative = path.relative(a, b),
    reverse = path.relative(b, a);
  const inside = (p: string) =>
    !p || (!p.startsWith(`..${path.sep}`) && p !== ".." && !path.isAbsolute(p));
  return inside(relative) || inside(reverse);
}
export function assertHistoryUnlocked(
  sessionId: string,
  rootsOverride?: string[],
): void {
  const db = getRawSqlite();
  if (
    db
      .prepare(
        "SELECT id FROM conversation_history_operations WHERE session_id=? AND state IN ('prepared','applying','recovery_required')",
      )
      .get(rootOwner(sessionId))
  )
    throw historyError(
      "History recovery is in progress or requires recovery.",
      "HISTORY_RECOVERY_REQUIRED",
    );
  const locks = db
    .prepare("SELECT root FROM conversation_workspace_locks")
    .all() as { root: string }[];
  if (
    locks.length &&
    (rootsOverride ?? sessionRoots(sessionId)).some((root) =>
      locks.some((lock) => rootsOverlap(root, lock.root)),
    )
  )
    throw historyError(
      "Workspace is locked for history recovery.",
      "HISTORY_WORKSPACE_LOCKED",
    );
}
export function assertHistoryIdle(sessionId: string): void {
  const db = getRawSqlite();
  for (const session of agentRuntimeStore.listSessionTree(sessionId)) {
    if (
      [
        "running",
        "queued",
        "stopping",
        "waiting_permission",
        "waiting_input",
      ].includes(session.status) ||
      session.sessionMetadata?.runtimeControl ||
      db
        .prepare(
          "SELECT id FROM agent_runtime_runs WHERE session_id=? AND (status IN ('queued','running') OR json_extract(metadata_json,'$.executionLease.closed')=0)",
        )
        .get(session.id)
    )
      throw historyError(
        "Stop the session and its agents before changing history.",
        "HISTORY_SESSION_BUSY",
      );
    if (
      db
        .prepare(
          "SELECT id FROM agent_runtime_processes WHERE session_id=? AND state<>'closed'",
        )
        .get(session.id)
    )
      throw historyError(
        "Stop background processes before changing history.",
        "HISTORY_PROCESS_ACTIVE",
      );
  }
}
export function acquireHistoryLocks(
  sessionId: string,
  operationId: string,
  roots: string[],
): void {
  const db = getRawSqlite();
  db.transaction(() => {
    assertHistoryUnlocked(sessionId, roots);
    assertHistoryIdle(sessionId);
    const ownTree = new Set(
      agentRuntimeStore.listSessionTree(sessionId).map((s) => s.id),
    );
    for (const otherId of activeWorkspaceSessions()) {
      if (ownTree.has(otherId)) continue;
      let otherRoots: string[];
      try {
        otherRoots = sessionRoots(otherId);
      } catch {
        continue;
      }
      if (otherRoots.some((a) => roots.some((b) => rootsOverlap(a, b))))
        throw historyError(
          "Stop other sessions using this workspace before restoring history.",
          "HISTORY_WORKSPACE_BUSY",
        );
    }
    for (const writerRoots of openWriterRoots()) {
      if (writerRoots.some((a) => roots.some((b) => rootsOverlap(a, b))))
        throw historyError(
          "Another execution may still be writing this workspace.",
          "HISTORY_WORKSPACE_BUSY",
        );
    }
    for (const root of roots)
      db.prepare(
        "INSERT INTO conversation_workspace_locks(root,operation_id) VALUES (?,?)",
      ).run(root, operationId);
  })();
}
export function releaseHistoryLocks(operationId: string): void {
  getRawSqlite()
    .prepare("DELETE FROM conversation_workspace_locks WHERE operation_id=?")
    .run(operationId);
}
