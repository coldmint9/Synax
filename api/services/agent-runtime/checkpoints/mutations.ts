import { appendOnlySession } from "./version-runtime/bridge.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getRawSqlite } from "../../../db/index.js";
import {
  checkpointFiles,
  excludedSnapshotPath,
  type FileChange,
} from "./files.js";
import {
  assertHistoryUnlocked,
  historyError,
  rootOwner,
  rootsOverlap,
  sessionRoots,
} from "./guards.js";
import { withSnapshotLease } from "./storage-leases.js";
import { recordGitBoundary } from "./git-boundary.js";
import { ensureHistoryAccess } from "./retention.js";

const statStamp = (file: string): string | null => {
  try {
    const s = fs.lstatSync(file);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};
function canonicalTarget(file: string): string {
  let parent = path.dirname(path.resolve(file));
  const suffix = [path.basename(file)];
  for (;;) {
    try {
      return path.join(fs.realpathSync(parent), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(path.basename(parent));
      parent = next;
    }
  }
}
interface Target {
  root: string;
  path: string;
}
/** Paths are supplied by a native file operation, NEVER inferred from a directory
 * diff. Omitted paths record an untracked side-effect warning, not ownership. */
export async function withCheckpointMutation<T>(
  sessionId: string,
  action: () => T | Promise<T>,
  external = false,
  paths?: string[],
): Promise<T> {
  return withSnapshotLease(() =>
    recordMutation(sessionId, action, external || appendOnlySession(sessionId), paths),
  );
}
async function recordMutation<T>(
  sessionId: string,
  action: () => T | Promise<T>,
  external: boolean,
  paths?: string[],
): Promise<T> {
  const db = getRawSqlite(),
    id = randomUUID(),
    owner = external ? `external:${sessionId}` : rootOwner(sessionId);
  let roots: string[] = [];
  try {
    roots = sessionRoots(sessionId);
  } catch {
    /* An unbound/remote tool can have effects, but cannot own workspace files. */
  }
  const targets: Target[] = [],
    skipped: string[] = [];
  for (const file of [...new Set(paths ?? [])]) {
    const absolute = canonicalTarget(file),
      root = roots.find((r) => absolute.startsWith(`${r}${path.sep}`));
    if (!root) {
      skipped.push(file);
      continue;
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (excludedSnapshotPath(relative)) {
      skipped.push(relative);
      continue;
    }
    targets.push({ root, path: relative });
  }
  const warning = !paths
    ? "Shell/MCP or other untracked side effects are not automatically undone."
    : skipped.length
      ? `Untracked or excluded paths are preserved: ${skipped.join(", ")}`
      : null;
  const absoluteTargets = targets.map((t) => path.join(t.root, t.path));
  db.transaction(() => {
    assertHistoryUnlocked(sessionId);
    ensureHistoryAccess(sessionId);
    const writers = db
      .prepare(
        "SELECT roots_json,paths_json FROM conversation_mutations WHERE state='open'",
      )
      .all() as { roots_json: string; paths_json: string }[];
    for (const writer of writers) {
      const other = JSON.parse(writer.paths_json) as Target[];
      const overlap =
        !targets.length && !other.length
          ? false
          : !targets.length || !other.length
            ? (JSON.parse(writer.roots_json) as string[]).some((a) =>
                roots.some((b) => rootsOverlap(a, b)),
              )
            : other.some((t) =>
                absoluteTargets.includes(path.join(t.root, t.path)),
              );
      if (overlap)
        throw historyError(
          "Another operation may be writing the same file. Retry after it finishes.",
          "FILE_WRITE_BUSY",
        );
    }
    db.prepare(
      "INSERT INTO conversation_mutations(id,session_id,owner_session_id,roots_json,paths_json,state,uncertain,created_at,owner_pid,format_version,warning) VALUES (?,?,?,?,?,'open',0,?,?,2,?)",
    ).run(
      id,
      sessionId,
      owner,
      JSON.stringify(roots),
      JSON.stringify(targets),
      new Date().toISOString(),
      process.pid,
      warning,
    );
  })();
  const changes: FileChange[] = [],
    beforeStamps = new Map<string, string | null>();
  let uncertain = false;
  try {
    // Before-images are durable before a native write is allowed to execute.
    for (const target of targets) {
      if (external) {
        const key = path.join(target.root, target.path);
        beforeStamps.set(key, statStamp(key));
        continue;
      }
      const before = await checkpointFiles.version(
        target.root,
        target.path,
        true,
      );
      const key = path.join(target.root, target.path);
      beforeStamps.set(key, statStamp(key));
      changes.push({
        ...target,
        before,
        after: null,
        git: await recordGitBoundary(target.root, target.path),
      });
    }
    db.prepare(
      "UPDATE conversation_mutations SET changes_json=? WHERE id=?",
    ).run(JSON.stringify(changes), id);
    for (const target of targets) {
      const key = path.join(target.root, target.path);
      if (statStamp(key) !== beforeStamps.get(key))
        throw historyError(
          "File changed before the write could begin.",
          "FILE_CHANGED",
        );
    }
  } catch (error) {
    db.prepare(
      "UPDATE conversation_mutations SET state='closed',changes_json='[]',warning='Write was cancelled because its before-image could not be safely recorded.' WHERE id=?",
    ).run(id);
    throw error;
  }
  let result: T | undefined,
    error: unknown,
    failed = false;
  try {
    const value = action();
    result =
      value && typeof (value as { then?: unknown }).then === "function"
        ? await value
        : (value as T);
  } catch (e) {
    failed = true;
    error = e;
  }
  // Read synchronously at the end of the native operation, before async IO
  // yields to another application writer. Late changes never get attributed.
  const afterStamps = new Map<string, string | null>();
  try {
    for (const target of targets) {
      const key = path.join(target.root, target.path);
      afterStamps.set(key, statStamp(key));
    }
  } catch {
    uncertain = true;
  }
  const recorded: FileChange[] = [];
  try {
    for (const change of changes) {
      if (uncertain) break;
      const key = path.join(change.root, change.path);
      if (beforeStamps.get(key) === afterStamps.get(key)) continue;
      change.after = await checkpointFiles.version(
        change.root,
        change.path,
        true,
      );
      if (statStamp(key) !== afterStamps.get(key))
        throw new Error("File changed after the native write.");
      recorded.push(change);
    }
  } catch {
    uncertain = true;
  }
  db.prepare(
    "UPDATE conversation_mutations SET state='closed',changes_json=?,paths_json=?,uncertain=?,warning=COALESCE(?,warning) WHERE id=?",
  ).run(
    JSON.stringify(uncertain ? [] : recorded),
    JSON.stringify(
      uncertain
        ? targets
        : external
          ? targets.filter(
              (t) =>
                beforeStamps.get(path.join(t.root, t.path)) !==
                afterStamps.get(path.join(t.root, t.path)),
            )
          : recorded.map((c) => ({ root: c.root, path: c.path })),
    ),
    uncertain ? 1 : 0,
    uncertain
      ? "A concurrent file change could not be attributed; it will be preserved."
      : null,
    id,
  );
  if (failed) throw error;
  return result as T;
}
export function recoverOrphanedCheckpointWriters(): void {
  const db = getRawSqlite(),
    through = (
      db
        .prepare(
          "SELECT COALESCE(MAX(sequence),0) AS cursor FROM conversation_mutations WHERE state='open'",
        )
        .get() as { cursor: number }
    ).cursor;
  const query = db.prepare(
    "SELECT sequence,id,owner_pid FROM conversation_mutations WHERE state='open' AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 64",
  );
  const close = db.prepare(
    "UPDATE conversation_mutations SET state='closed',uncertain=1,warning='Interrupted writer: file ownership could not be verified.' WHERE id=? AND state='open'",
  );
  let after = 0;
  for (;;) {
    const rows = query.all(after, through) as {
      sequence: number;
      id: string;
      owner_pid: number | null;
    }[];
    if (!rows.length) return;
    for (const row of rows) {
      after = row.sequence;
      if (!row.owner_pid || row.owner_pid < 1) continue;
      try {
        process.kill(row.owner_pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH")
          close.run(row.id);
      }
    }
  }
}
