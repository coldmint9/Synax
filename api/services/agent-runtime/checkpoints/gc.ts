import { expireFileUndo } from "./retention.js";
import fs from "node:fs/promises";
import path from "node:path";
import { getRawSqlite } from "../../../db/index.js";
import { checkpointFiles } from "./files.js";
import { beginSnapshotPrune, endSnapshotPrune } from "./storage-leases.js";

/** Opportunistic collection. A fork's immutable manifest is an independent reference. */
export async function pruneCheckpointBlobs(): Promise<number> {
  expireFileUndo();
  const lease = beginSnapshotPrune();
  if (!lease) return 0;
  try {
    const db = getRawSqlite();
    const rows = db.transaction(() => {
      const minimum = (
        db
          .prepare(
            "SELECT MIN(mutation_cursor) AS cursor FROM conversation_checkpoints",
          )
          .get() as { cursor: number | null }
      ).cursor;
      if (minimum === null)
        db.prepare(
          "DELETE FROM conversation_mutations WHERE state<>'open'",
        ).run();
      else
        db.prepare(
          "DELETE FROM conversation_mutations WHERE sequence<=? AND state<>'open'",
        ).run(minimum);
      // Results/request hashes retain idempotency; completed rollback before-images are no longer needed for compensation.
      db.prepare(
        "UPDATE conversation_history_operations SET payload_json='{}' WHERE state IN ('committed','aborted') AND json_extract(payload_json,'$.kind') IS NOT 'fork'",
      ).run();
      return [
        ...db
          .prepare("SELECT payload_json AS value FROM conversation_checkpoints")
          .all(),
        ...db
          .prepare("SELECT changes_json AS value FROM conversation_mutations")
          .all(),
        ...db
          .prepare(
            "SELECT payload_json AS value FROM conversation_history_operations",
          )
          .all(),
      ] as { value: string }[];
    })();
    const live = new Set(
      rows.flatMap((row) => row.value.match(/[a-f0-9]{64}/g) ?? []),
    );
    const directory = path.join(checkpointFiles.directory, "blobs");
    let removed = 0;
    for (const prefix of await fs.readdir(directory).catch(() => [])) {
      if (/^\.pending-[0-9a-f-]{36}$/.test(prefix)) {
        const pending=path.join(directory,prefix);
        if ((await fs.lstat(pending)).isFile()) { await fs.unlink(pending); removed++; }
        continue;
      }
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const folder = path.join(directory, prefix),
        stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      for (const name of await fs.readdir(folder)) {
        const temporary=/^[a-f0-9]{62}\.[0-9a-f-]{36}\.tmp$/.test(name);
        if (!temporary && (!/^[a-f0-9]{62}$/.test(name) || live.has(prefix + name))) continue;
        const file = path.join(folder, name),
          info = await fs.lstat(file);
        if (info.isFile()) {
          await fs.unlink(file);
          removed++;
        }
      }
    }
    return removed;
  } finally {
    endSnapshotPrune(lease);
  }
}
