import { withSnapshotLease } from "./storage-leases.js";
import { randomUUID } from "node:crypto";
import { getRawSqlite } from "../../../db/index.js";
import { checkpointFiles, diffManifests, type FileManifest } from "./files.js";
import {
  assertHistoryUnlocked,
  rootOwner,
  rootsOverlap,
  sessionRoots,
} from "./guards.js";

/** Tool-scoped attribution, deliberately conservative for overlapping writers. */
export async function withCheckpointMutation<T>(
  sessionId: string,
  action: () => Promise<T> | T,
  external = false,
): Promise<T> {
  return withSnapshotLease(() =>
    recordCheckpointMutation(sessionId, action, external),
  );
}
async function recordCheckpointMutation<T>(
  sessionId: string,
  action: () => Promise<T> | T,
  external = false,
): Promise<T> {
  const db = getRawSqlite(),
    id = randomUUID(),
    owner = external ? `external:${sessionId}` : rootOwner(sessionId);
  const roots = sessionRoots(sessionId);
  db.transaction(() => {
    assertHistoryUnlocked(sessionId);
    const writers = db
      .prepare(
        "SELECT id, roots_json FROM conversation_mutations WHERE state='open'",
      )
      .all() as { id: string; roots_json: string }[];
    const overlaps = writers.filter((writer) =>
      (JSON.parse(writer.roots_json) as string[]).some((a) =>
        roots.some((b) => rootsOverlap(a, b)),
      ),
    );
    for (const writer of overlaps)
      db.prepare(
        "UPDATE conversation_mutations SET uncertain=1 WHERE id=?",
      ).run(writer.id);
    db.prepare(
      "INSERT INTO conversation_mutations(id,session_id,owner_session_id,roots_json,state,uncertain,created_at,owner_pid) VALUES (?,?,?,?,'open',?,?,?)",
    ).run(
      id,
      sessionId,
      owner,
      JSON.stringify(roots),
      overlaps.length ? 1 : 0,
      new Date().toISOString(),
      process.pid,
    );
  })();
  let before: FileManifest[] | undefined;
  try {
    before = await Promise.all(
      roots.map((root) => checkpointFiles.capture(root, true)),
    );
  } catch {
    db.prepare("UPDATE conversation_mutations SET uncertain=1 WHERE id=?").run(
      id,
    );
  }
  try {
    return await action();
  } finally {
    try {
      const after = await Promise.all(
        roots.map((root) => checkpointFiles.capture(root, true)),
      );
      if (!before) throw new Error("Missing before snapshot");
      const background = db
        .prepare(
          "SELECT id FROM agent_runtime_processes WHERE session_id=? AND kind='background' AND state<>'closed'",
        )
        .get(sessionId);
      db.prepare(
        "UPDATE conversation_mutations SET state='closed', changes_json=?, uncertain=MAX(uncertain,?) WHERE id=?",
      ).run(
        JSON.stringify(diffManifests(before, after)),
        background ? 1 : 0,
        id,
      );
    } catch {
      db.prepare(
        "UPDATE conversation_mutations SET state='closed',uncertain=1 WHERE id=?",
      ).run(id);
    }
  }
}

/** Lost before-images cannot be trusted: close a dead writer as uncertain, never as successfully captured. */
export function recoverOrphanedCheckpointWriters(): void {
  const db = getRawSqlite();
  const rows = db
    .prepare(
      "SELECT id,owner_pid FROM conversation_mutations WHERE state='open'",
    )
    .all() as { id: string; owner_pid: number | null }[];
  for (const row of rows) {
    if (!row.owner_pid) continue;
    let alive = true;
    try {
      process.kill(row.owner_pid, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (!alive)
      db.prepare(
        "UPDATE conversation_mutations SET state='closed',uncertain=1 WHERE id=? AND state='open'",
      ).run(row.id);
  }
}
