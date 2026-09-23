import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getRawSqlite } from "../../../db/index.js";

function reap(): void {
  const db = getRawSqlite(),
    query = db.prepare(
      "SELECT id,owner_pid FROM conversation_snapshot_leases WHERE id>? ORDER BY id LIMIT 64",
    ),
    remove = db.prepare("DELETE FROM conversation_snapshot_leases WHERE id=?");
  let after = "";
  for (;;) {
    const rows = query.all(after) as { id: string; owner_pid: number }[];
    if (!rows.length) return;
    for (const row of rows) {
      after = row.id;
      if (!Number.isSafeInteger(row.owner_pid) || row.owner_pid < 1) continue;
      try {
        process.kill(row.owner_pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH")
          remove.run(row.id);
      }
    }
  }
}
export async function withSnapshotLease<T>(
  action: () => Promise<T>,
): Promise<T> {
  const db = getRawSqlite(),
    id = randomUUID(),
    deadline = Date.now() + 30_000;
  for (;;) {
    const acquired = db.transaction(() => {
      reap();
      if (
        db
          .prepare(
            "SELECT id FROM conversation_snapshot_leases WHERE kind='gc'",
          )
          .get()
      )
        return false;
      db.prepare(
        "INSERT INTO conversation_snapshot_leases VALUES (?,'capture',?)",
      ).run(id, process.pid);
      return true;
    })();
    if (acquired) break;
    if (Date.now() > deadline)
      throw new Error("Snapshot maintenance is busy. Retry the operation.");
    await delay(25);
  }
  try {
    return await action();
  } finally {
    db.prepare("DELETE FROM conversation_snapshot_leases WHERE id=?").run(id);
  }
}
export function beginSnapshotPrune(): string | null {
  const db = getRawSqlite();
  return db.transaction(() => {
    reap();
    if (
      db.prepare("SELECT id FROM conversation_snapshot_leases LIMIT 1").get() ||
      db
        .prepare("SELECT root FROM conversation_workspace_locks LIMIT 1")
        .get() ||
      db
        .prepare(
          "SELECT id FROM conversation_mutations WHERE state='open' LIMIT 1",
        )
        .get()
    )
      return null;
    const id = randomUUID();
    db.prepare(
      "INSERT INTO conversation_snapshot_leases VALUES (?,'gc',?)",
    ).run(id, process.pid);
    return id;
  })();
}
export function endSnapshotPrune(id: string): void {
  getRawSqlite()
    .prepare("DELETE FROM conversation_snapshot_leases WHERE id=?")
    .run(id);
}
