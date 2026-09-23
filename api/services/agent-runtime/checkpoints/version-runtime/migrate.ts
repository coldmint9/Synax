import { randomUUID } from "node:crypto";
import { setImmediate as yieldNow } from "node:timers/promises";
import { getRawSqlite } from "../../../../db/index.js";
import { agentRuntimeStore, mapLegacyHistoryRow } from "../../session-store.js";
import type { RuntimeContentPart } from "../../content-parts.js";
import { AgentRuntimeError } from "../../runtime-errors.js";
import {
  assertHistoryIdle,
  assertHistoryUnlocked,
  historyRevision,
} from "../guards.js";
import { VersionHeads } from "../version-store/heads.js";
import { atomicVersionWrite } from "../version-store/transaction.js";
import { VersionCollector } from "../version-store/gc.js";
import { hashBytes } from "../version-store/hash-codec.js";
import {
  historySessionFields,
  versionRepository,
  versionedSession,
} from "./bridge.js";
import { retainVersionRecordAssets } from "./assets.js";

const tables = [
  ["agent_runtime_messages", "messages"],
  ["agent_runtime_context_bundles", "contexts"],
  ["agent_runtime_compaction_summaries", "compactions"],
  ["agent_runtime_work", "work"],
  ["agent_runtime_asset_sessions", "assets"],
] as const;
interface Migration {
  session_id: string;
  staging_id: string;
  table_index: number;
  after_rowid: number;
  source_revision: number;
  state: string;
}
let running = false;
const error = (text: string, code = "HISTORY_MIGRATION_REQUIRED") =>
  new AgentRuntimeError(text, code, 409);

/** Explicitly retires old checkpoints, not transcript content. Never replays the
 * legacy undo journal. No background concurrency queue and no long transaction. */
export async function upgradeHistory(
  sessionId: string,
): Promise<{ upgraded: boolean }> {
  if (versionedSession(sessionId)) return { upgraded: true };
  if (running)
    throw error(
      "Another history upgrade is running; retry later.",
      "HISTORY_MIGRATION_BUSY",
    );
  running = true;
  const db = getRawSqlite(),
    repo = versionRepository();
  const read = () =>
    db
      .prepare("SELECT * FROM conversation_v3_migrations WHERE session_id=?")
      .get(sessionId) as Migration | undefined;
  try {
    let migration = read();
    if (migration && migration.state !== "copying")
      throw error("Previous staging data is being reclaimed. Retry shortly.");
    const session = agentRuntimeStore.getSession(sessionId);
    if (
      session.parentSessionId ||
      session.childSessionIds.length ||
      ((session.sessionMetadata?.backend as { id?: string })?.id ??
        "native") !== "native"
    )
      throw error(
        "Only an inactive Native root without child sessions can be upgraded.",
      );
    assertHistoryIdle(sessionId);
    if (!migration) {
      assertHistoryUnlocked(sessionId);
      atomicVersionWrite(db, () => {
        const staging = `vmig_${randomUUID()}`;
        repo.create(staging, historySessionFields(session));
        db.prepare(
          "INSERT INTO conversation_v3_migrations(session_id,staging_id,source_revision) VALUES(?,?,?)",
        ).run(sessionId, staging, historyRevision(sessionId));
      });
      migration = read()!;
    }
    while (migration.table_index < tables.length) {
      const [table, kind] = tables[migration.table_index];
      const columns = (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      )
        .map((c) => c.name)
        .filter((c) => c !== "_metadata");
      const size = columns
        .map((c) => `COALESCE(length(CAST("${c}" AS BLOB)),0)`)
        .join("+");
      // Only current decision state is copied. All runs, tools, events and
      // accounting remain audit records in their original tables.
      const extra =
        kind === "contexts"
          ? " AND id=?"
          : kind === "work"
            ? " AND id=?"
            : kind === "compactions"
              ? " AND id=(SELECT id FROM agent_runtime_compaction_summaries WHERE session_id=? ORDER BY created_at DESC LIMIT 1)"
              : "";
      const params: (string | number)[] = [sessionId, migration.after_rowid];
      if (kind === "contexts") params.push(session.contextSnapshotId ?? "");
      if (kind === "work")
        params.push(String(session.sessionMetadata?.activeWorkId ?? ""));
      if (kind === "compactions") params.push(sessionId);
      const rows = db
        .prepare(
          `SELECT rowid AS id,${size} AS bytes FROM ${table} WHERE session_id=? AND rowid>?${extra} ORDER BY rowid LIMIT 16`,
        )
        .all(...params) as { id: number; bytes: number }[];
      atomicVersionWrite(db, () => {
        if (historyRevision(sessionId) !== migration!.source_revision)
          throw error("Source changed during upgrade.", "HISTORY_STALE");
        let bytes = 0;
        for (const meta of rows) {
          if (meta.bytes > 768 * 1024)
            throw error(
              "A legacy record exceeds the bounded upgrade budget; the original history was left untouched.",
            );
          if (bytes && bytes + meta.bytes > 768 * 1024) break;
          bytes += meta.bytes;
          const row = db
            .prepare(
              `SELECT ${columns.map((c) => `"${c}"`).join(",")} FROM ${table} WHERE rowid=? AND session_id=?`,
            )
            .get(meta.id, sessionId) as Record<string, unknown>;
          const id = String(kind === "assets" ? row.asset_id : row.id);
          let fields = mapLegacyHistoryRow(table, row);
          if (kind === "assets")
            fields = { assetId: id, projectId: session.projectId };
          if (!["messages", "assets"].includes(kind))
            fields.__synaxExecutionEpoch = 0;
          repo.put(migration!.staging_id, kind, id, fields);
          if (Array.isArray(fields.contentParts))
            retainVersionRecordAssets(
              migration!.staging_id,
              kind,
              id,
              fields.contentParts as RuntimeContentPart[],
              sessionId,
            );
          if (kind === "assets") {
            const ref = repo.recordReference(migration!.staging_id, kind, id)!;
            db.prepare(
              "INSERT OR IGNORE INTO conversation_v3_asset_refs(object_hash,asset_id) VALUES(?,?)",
            ).run(hashBytes(ref), id);
          }
          migration!.after_rowid = meta.id;
        }
        if (!rows.length) {
          migration!.table_index++;
          migration!.after_rowid = 0;
        }
        db.prepare(
          "UPDATE conversation_v3_migrations SET table_index=?,after_rowid=? WHERE session_id=?",
        ).run(migration!.table_index, migration!.after_rowid, sessionId);
      });
      new VersionCollector(repo.objects).collect({ maxObjects: 32, maxMs: 3 });
      await yieldNow();
    }
    atomicVersionWrite(db, () => {
      if (historyRevision(sessionId) !== migration!.source_revision)
        throw error("Source changed during upgrade.", "HISTORY_STALE");
      // Removing the copy fence and publishing the head are one atomic change.
      db.prepare(
        "UPDATE conversation_v3_migrations SET state='cleanup' WHERE session_id=?",
      ).run(sessionId);
      new VersionHeads(db, repo.objects).create(
        sessionId,
        repo.head(migration!.staging_id).versionId,
      );
      db.prepare(
        "UPDATE conversation_v3_heads SET runtime_mode='native',boundary_only=1,legacy_runtime=1 WHERE session_id=?",
      ).run(sessionId);
      db.prepare(
        "DELETE FROM conversation_history_tracking WHERE session_id=?",
      ).run(sessionId);
    });
    return { upgraded: true };
  } catch (cause) {
    // A clean failure leaves v2 usable. A process crash leaves 'copying' and can
    // resume from the persisted rowid by calling the same endpoint again.
    if (!versionedSession(sessionId))
      db.prepare(
        "UPDATE conversation_v3_migrations SET state='abandoned' WHERE session_id=?",
      ).run(sessionId);
    throw cause;
  } finally {
    running = false;
  }
}
