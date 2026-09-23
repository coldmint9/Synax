import { setImmediate as yieldNow } from "node:timers/promises";
import { recoverOrphanedCheckpointWriters } from "./mutations.js";
import { logger } from "../../../lib/logger.js";
import { getRawSqlite } from "../../../db/index.js";
import { rootOwner } from "./guards.js";
import { agentRuntimeStore } from "../session-store.js";
export const FILE_UNDO_RETENTION_MS = 24 * 60 * 60 * 1000;
export function ensureHistoryAccess(sessionId: string, now = Date.now()): void {
  getRawSqlite()
    .prepare(
      "INSERT OR IGNORE INTO conversation_history_access(session_id,last_access_at) VALUES (?,?)",
    )
    .run(rootOwner(sessionId), now);
}
export function expireFileUndo(now = Date.now(), sessionId?: string): number {
  return expireOwner(now, sessionId ? rootOwner(sessionId) : undefined);
}
function expireOwner(now: number, sessionId?: string): number {
  const db = getRawSqlite();
  return db.transaction(() => {
    const candidates = db
      .prepare(
        `SELECT session_id,last_access_at,expire_through FROM conversation_history_access
      WHERE (last_access_at<? OR expire_through>0) ${sessionId ? "AND session_id=?" : ""}`,
      )
      .all(
        ...(sessionId
          ? [now - FILE_UNDO_RETENTION_MS, sessionId]
          : [now - FILE_UNDO_RETENTION_MS]),
      ) as {
      session_id: string;
      last_access_at: number;
      expire_through: number;
    }[];
    let count = 0;
    for (const access of candidates) {
      const id = access.session_id;
      let cutoff = access.expire_through;
      if (access.last_access_at < now - FILE_UNDO_RETENTION_MS) {
        cutoff = Math.max(
          cutoff,
          (
            db
              .prepare(
                "SELECT COALESCE(MAX(sequence),0) AS cursor FROM conversation_mutations WHERE owner_session_id=?",
              )
              .get(id) as { cursor: number }
          ).cursor,
        );
        db.prepare(
          "UPDATE conversation_history_access SET expire_through=? WHERE session_id=?",
        ).run(cutoff, id);
      }
      // Persist a cutoff even if cleanup is deferred. A new visit cannot revive
      // before-images that had already expired while an operation was finishing.
      if (
        db
          .prepare(
            "SELECT id FROM conversation_history_operations WHERE session_id=? AND state IN ('prepared','applying','recovery_required','fork_preparing')",
          )
          .get(id) ||
        db
          .prepare(
            "SELECT id FROM conversation_mutations WHERE owner_session_id=? AND state='open' AND sequence<=?",
          )
          .get(id, cutoff)
      )
        continue;
      count += Number(
        db
          .prepare(
            "UPDATE conversation_mutations SET state='expired',changes_json='[]',warning='File undo expired after 24 hours without an active visit.' WHERE owner_session_id=? AND sequence<=? AND state NOT IN ('open','expired','reverted')",
          )
          .run(id, cutoff).changes,
      );
      db.prepare(
        "UPDATE conversation_history_access SET expire_through=0 WHERE session_id=?",
      ).run(id);
    }
    return count;
  })();
}
/** Background traversal yields between bounded identity pages. The per-owner
 * expiry transaction still uses the existing atomic policy and cutoff semantics. */
export async function expireFileUndoCooperatively(
  now = Date.now(),
): Promise<number> {
  const db = getRawSqlite(),
    query = db.prepare(
      "SELECT session_id FROM conversation_history_access WHERE session_id>? AND (last_access_at<? OR expire_through>0) ORDER BY session_id LIMIT 64",
    );
  let after = "",
    changed = 0;
  for (;;) {
    const rows = query.all(after, now - FILE_UNDO_RETENTION_MS) as {
      session_id: string;
    }[];
    if (!rows.length) return changed;
    for (const row of rows) {
      after = row.session_id;
      changed += expireOwner(now, row.session_id);
    }
    await yieldNow();
  }
}
export function visitConversation(sessionId: string, now = Date.now()): void {
  agentRuntimeStore.getSession(sessionId);
  // Returning after expiration cannot extend the life of already-expired data.
  expireFileUndo(now, sessionId);
  getRawSqlite()
    .prepare(
      "INSERT INTO conversation_history_access(session_id,last_access_at) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET last_access_at=excluded.last_access_at",
    )
    .run(rootOwner(sessionId), now);
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startFileUndoRetention(): () => void {
  if (timer) return () => {};
  const sweep = () => {
    try {
      recoverOrphanedCheckpointWriters();
    } catch (error) {
      logger.warn({ error }, "file undo cleanup failed");
      return;
    }
    void import("./gc.js")
      .then((m) => m.pruneCheckpointBlobs())
      .catch(() => {});
  };
  sweep();
  timer = setInterval(sweep, 60_000);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}
