import { expireFileUndoCooperatively } from "./retention.js";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldNow } from "node:timers/promises";
import { getRawSqlite } from "../../../db/index.js";
import { checkpointFiles } from "./files.js";
import { beginSnapshotPrune, endSnapshotPrune } from "./storage-leases.js";
import { BlobMarks } from "./blob-marks.js";
import { historyError } from "./guards.js";

const SOURCE_BYTES = 1024 * 1024;
const SOURCES = [
  { table: "conversation_checkpoints", column: "payload_json" },
  { table: "conversation_mutations", column: "changes_json" },
  { table: "conversation_history_operations", column: "payload_json" },
] as const;

/** Only fixed schema identifiers enter this query; callers cannot supply SQL. */
async function* referenceSources(): AsyncGenerator<string> {
  const db = getRawSqlite();
  for (const { table, column } of SOURCES) {
    let after = 0;
    const bound = (
      db
        .prepare(`SELECT COALESCE(MAX(rowid),0) AS last FROM ${table}`)
        .get() as { last: number }
    ).last;
    const ids = db.prepare(
      `SELECT rowid AS cursor FROM ${table} WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 64`,
    );
    const payload = db.prepare(
      `SELECT CASE WHEN length(CAST(${column} AS BLOB))<=${SOURCE_BYTES} THEN ${column} ELSE NULL END AS value,
        CASE WHEN length(CAST(${column} AS BLOB))<=${SOURCE_BYTES} THEN json_valid(${column}) ELSE 0 END AS valid FROM ${table} WHERE rowid=?`,
    );
    for (;;) {
      const rows = ids.all(after, bound) as { cursor: number }[];
      if (!rows.length) break;
      for (const row of rows) {
        after = row.cursor;
        const value = payload.get(after) as
          | { value: string | null }
          | undefined;
        if (!value) continue;
        if (value.value === null)
          throw historyError(
            "File GC reference metadata exceeds its scan budget; no blobs were deleted.",
            "SNAPSHOT_GC_LIMIT",
          );
        if (!value.valid)
          throw historyError(
            "Invalid reference metadata; collection was cancelled before sweeping.",
            "SNAPSHOT_GC_LIMIT",
          );
        yield value.value;
      }
      await yieldNow();
    }
  }
}
async function retireUnusedEvidence(): Promise<void> {
  const db = getRawSqlite();
  const row = db
    .prepare(
      "SELECT MIN(cursor) AS cursor FROM (SELECT MIN(mutation_cursor) AS cursor FROM conversation_checkpoints UNION ALL SELECT MIN(COALESCE(file_retention_floor,0)) AS cursor FROM conversation_v3_heads WHERE checkpoint_root IS NOT NULL)",
    )
    .get() as { cursor: number | null };
  const remove =
    row.cursor === null
      ? db.prepare(
          "DELETE FROM conversation_mutations WHERE sequence IN (SELECT sequence FROM conversation_mutations WHERE state<>'open' ORDER BY sequence LIMIT 128)",
        )
      : db.prepare(
          "DELETE FROM conversation_mutations WHERE sequence IN (SELECT sequence FROM conversation_mutations WHERE state<>'open' AND sequence<=? ORDER BY sequence LIMIT 128)",
        );
  for (;;) {
    const changed = Number(
      row.cursor === null
        ? remove.run().changes
        : remove.run(row.cursor).changes,
    );
    if (!changed) break;
    await yieldNow();
  }
  // Compact only one bounded completed journal at a time; a committed fork's
  // immutable manifest is still a root and must not be dropped.
  const ids = db.prepare(
    "SELECT id FROM conversation_history_operations WHERE id>? AND state IN ('committed','aborted') AND payload_json<>'{}' ORDER BY id LIMIT 64",
  );
  const read = db.prepare(
    `SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=${SOURCE_BYTES} THEN payload_json ELSE NULL END AS value,
      CASE WHEN length(CAST(payload_json AS BLOB))<=${SOURCE_BYTES} THEN json_valid(payload_json) ELSE 0 END AS valid,
      CASE WHEN length(CAST(payload_json AS BLOB))<=${SOURCE_BYTES} THEN CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.kind')='fork' ELSE 0 END ELSE 0 END AS is_fork
      FROM conversation_history_operations WHERE id=? AND state IN ('committed','aborted')`,
  );
  const clear = db.prepare(
    "UPDATE conversation_history_operations SET payload_json='{}' WHERE id=? AND payload_json=? AND state IN ('committed','aborted')",
  );
  let after = "";
  for (;;) {
    const rows = ids.all(after) as { id: string }[];
    if (!rows.length) break;
    for (const row of rows) {
      after = row.id;
      const data = read.get(row.id) as
        | { value: string | null; valid: number; is_fork: number | null }
        | undefined;
      if (!data) continue;
      if (data.value === null)
        throw historyError(
          "Completed file journal exceeds the GC scan budget.",
          "SNAPSHOT_GC_LIMIT",
        );
      if (!data.valid)
        throw historyError(
          "Invalid file journal; collection was cancelled.",
          "SNAPSHOT_GC_LIMIT",
        );
      if (!data.is_fork) clear.run(row.id, data.value);
    }
    await yieldNow();
  }
}
async function* entries(directory: string) {
  let handle: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    handle = await fs.opendir(directory, { bufferSize: 32 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of handle) yield entry;
}

/** Mark completely before deleting any blob. The exclusive snapshot lease keeps
 * managed file writers/forks out of this cycle. No whole-history JS hash set. */
export async function pruneCheckpointBlobs(): Promise<number> {
  await expireFileUndoCooperatively();
  const lease = beginSnapshotPrune();
  if (!lease) return 0;
  let marks: BlobMarks | undefined;
  try {
    await retireUnusedEvidence();
    marks = await BlobMarks.create(checkpointFiles.directory);
    for await (const value of referenceSources()) await marks.mark(value);
    marks.seal();
    let removed = 0,
      visited = 0;
    const directory = path.join(checkpointFiles.directory, "blobs");
    for await (const prefix of entries(directory)) {
      if (prefix.isFile() && /^\.pending-[0-9a-f-]{36}$/.test(prefix.name)) {
        await fs.unlink(path.join(directory, prefix.name));
        removed++;
        continue;
      }
      if (
        !prefix.isDirectory() ||
        prefix.isSymbolicLink() ||
        !/^[a-f0-9]{2}$/.test(prefix.name)
      )
        continue;
      const folder = path.join(directory, prefix.name),
        info = await fs.lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      for await (const entry of entries(folder)) {
        if (++visited % 128 === 0) await yieldNow();
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const temporary = /^[a-f0-9]{62}\.[0-9a-f-]{36}\.tmp$/.test(entry.name);
        if (
          !temporary &&
          (!/^[a-f0-9]{62}$/.test(entry.name) ||
            marks.has(prefix.name + entry.name))
        )
          continue;
        await fs.unlink(path.join(folder, entry.name));
        removed++;
      }
    }
    return removed;
  } finally {
    try {
      await marks?.close();
    } finally {
      endSnapshotPrune(lease);
    }
  }
}
