import { collectDeletedHistory } from "./deletion.js";
import { getRawSqlite } from "../../../../db/index.js";
import { logger } from "../../../../lib/logger.js";
import { VersionCollector } from "../version-store/gc.js";
import { atomicVersionWrite } from "../version-store/transaction.js";
import { versionRepository } from "./bridge.js";

/** One bounded step, including abandoned/resumable migration staging cleanup.
 * Never VACUUM or scan a session's complete history on the API event loop. */
export function maintainVersionHistory(): void {
  const db = getRawSqlite(),
    repo = versionRepository();
  const migration = db
    .prepare(
      "SELECT session_id,staging_id,state FROM conversation_v3_migrations WHERE state<>'copying' ORDER BY session_id LIMIT 1",
    )
    .get() as
    | { session_id: string; staging_id: string; state: string }
    | undefined;
  if (migration)
    atomicVersionWrite(db, () => {
      const { session_id: id, staging_id: stage } = migration;
      // Ownership proofs are not pins. Delete only one metadata page at a time.
      const removed = db
        .prepare(
          `DELETE FROM conversation_v3_owned_versions WHERE session_id=? AND version_id IN
      (SELECT version_id FROM conversation_v3_owned_versions WHERE session_id=? LIMIT 64)`,
        )
        .run(stage, stage).changes;
      if (!removed) {
        db.prepare("DELETE FROM conversation_v3_heads WHERE session_id=?").run(
          stage,
        );
        if (migration.state === "cleanup") {
          // Preserve file recovery records and before-images. Only retire the undo
          // machinery the user explicitly acknowledged; never duplicate it in v3.
          for (const table of [
            "conversation_history_journal",
            "conversation_checkpoints",
          ]) {
            const count = db
              .prepare(
                `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE session_id=? LIMIT 64)`,
              )
              .run(id).changes;
            if (count) return;
          }
          // Low-value legacy event tails may be dropped; they are not checkpoints.
          // Keep the raw execution audit, but not a duplicate transcript table.
          for (const table of [
            "agent_runtime_events",
            "agent_runtime_messages",
          ]) {
            const untracked =
              table === "agent_runtime_events"
                ? " AND NOT EXISTS(SELECT 1 FROM conversation_v3_runtime_records r WHERE r.session_id=agent_runtime_events.session_id AND r.kind='events' AND r.record_id=agent_runtime_events.id)"
                : "";
            const count = db
              .prepare(
                `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE session_id=?${untracked} LIMIT 64)`,
              )
              .run(id).changes;
            if (count) return;
          }
        }
        db.prepare(
          "DELETE FROM conversation_v3_migrations WHERE session_id=?",
        ).run(id);
      }
    });
  collectDeletedHistory();
  new VersionCollector(repo.objects).collect({
    maxObjects: 128,
    maxMs: 4,
    maxEdges: 2048,
  });
}

let timer: ReturnType<typeof setTimeout> | undefined;
export function startVersionHistoryMaintenance(): () => void {
  if (timer) return () => {};
  let stopped = false,
    ticks = 0,
    lastWarning = 0;
  const tick = () => {
    if (stopped) return;
    try {
      maintainVersionHistory();
      if (++ticks % 100 === 0) {
        // PASSIVE never waits on a reader/writer; no foreground truncate/vacuum.
        const db = getRawSqlite();
        if (!db.inTransaction) {
          const status = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as {
            busy: number;
            log: number;
            checkpointed: number;
          };
          if (!status.busy && status.log === status.checkpointed) {
            // Zero busy timeout: release an allocated WAL high-water mark without
            // waiting on another process. Otherwise physical admission could
            // remain closed even after all frames have been checkpointed.
            const timeout = (
              db.prepare("PRAGMA busy_timeout").get() as { timeout: number }
            ).timeout;
            try {
              db.exec("PRAGMA busy_timeout=0");
              db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
            } finally {
              db.exec(`PRAGMA busy_timeout=${timeout}`);
            }
          }
        }
      }
    } catch (error) {
      if (Date.now() - lastWarning > 60_000) {
        logger.warn({ error }, "bounded history maintenance deferred");
        lastWarning = Date.now();
      }
    }
    timer = setTimeout(tick, 50);
    timer.unref();
  };
  timer = setTimeout(tick, 50);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}
