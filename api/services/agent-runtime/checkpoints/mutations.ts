import { appendOnlySession } from "./version-runtime/bridge.js";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
const MUTATION_WAIT_DEFAULT_MS = 15_000;
const MUTATION_WAIT_MAX_MS = 120_000;
const MUTATION_POLL_MIN_MS = 25;
const MUTATION_POLL_MAX_MS = 250;
/** How long a caller that lost a claim should wait before retrying. Bounded by
 * the poll ceiling, so retrying sooner than this is unlikely to succeed. */
export const MUTATION_RETRY_AFTER_MS = MUTATION_POLL_MAX_MS;
/** How long a writer may wait for a competing writer. 0 restores the previous
 * fail-fast behaviour; the ceiling keeps a wedged holder bounded. */
export function mutationWaitBudgetMs(): number {
  const configured = process.env.SYNAX_CHECKPOINT_MUTATION_WAIT_MS;
  const raw = Number(configured);
  if (!configured || !Number.isFinite(raw)) return MUTATION_WAIT_DEFAULT_MS;
  return Math.min(Math.max(Math.trunc(raw), 0), MUTATION_WAIT_MAX_MS);
}
/** The live writer a claim lost to. Reported so the caller can decide whether to
 * wait, retry or surface the conflict instead of guessing. */
export interface MutationConflict {
  /** `path` when the overlap was proven per file, `root` when either side could
   * not name its files and the whole workspace root had to be reserved. */
  kind: "path" | "root";
  holderSessionId: string;
  holderOwner: string;
  holderSequence: number;
  /** Age of the holder claim, or -1 when `created_at` is unreadable. */
  holderAgeMs: number;
  /** Files the holder named; empty for an untracked writer. */
  holderPaths: string[];
}
/** The write intent of one mutation. Resolving it reads the filesystem only to
 * canonicalize paths, so recomputing it after a lost claim is safe. */
interface PreparedMutation {
  external: boolean;
  owner: string;
  roots: string[];
  targets: Target[];
  absoluteTargets: string[];
  warning: string | null;
}
function prepareMutation(
  sessionId: string,
  external: boolean,
  paths?: string[],
): PreparedMutation {
  const owner = external ? `external:${sessionId}` : rootOwner(sessionId);
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
  return {
    external,
    owner,
    roots,
    targets,
    absoluteTargets: targets.map((t) => path.join(t.root, t.path)),
    warning,
  };
}
/** Reserves the prepared targets, or names the live writer that holds them.
 * Carries no workspace side effect: the overlap check and the `open` row are
 * written in one transaction, so a lost claim leaves nothing behind and the
 * whole step is safe to retry. */
function claimMutation(
  sessionId: string,
  prepared: PreparedMutation,
): { id: string } | MutationConflict {
  const db = getRawSqlite(),
    id = randomUUID();
  return db.transaction(() => {
    assertHistoryUnlocked(sessionId);
    ensureHistoryAccess(sessionId);
    const writers = db
      .prepare(
        "SELECT sequence,session_id,owner_session_id,roots_json,paths_json,created_at FROM conversation_mutations WHERE state='open'",
      )
      .all() as {
      sequence: number;
      session_id: string;
      owner_session_id: string;
      roots_json: string;
      paths_json: string;
      created_at: string;
    }[];
    for (const writer of writers) {
      const other = JSON.parse(writer.paths_json) as Target[];
      const overlap =
        !prepared.targets.length && !other.length
          ? false
          : !prepared.targets.length || !other.length
            ? (JSON.parse(writer.roots_json) as string[]).some((a) =>
                prepared.roots.some((b) => rootsOverlap(a, b)),
              )
            : other.some((t) =>
                prepared.absoluteTargets.includes(path.join(t.root, t.path)),
              );
      if (!overlap) continue;
      const createdAt = Date.parse(writer.created_at);
      return {
        kind: (!prepared.targets.length || !other.length
          ? "root"
          : "path") as MutationConflict["kind"],
        holderSessionId: writer.session_id,
        holderOwner: writer.owner_session_id,
        holderSequence: writer.sequence,
        holderAgeMs: Number.isFinite(createdAt)
          ? Math.max(0, Date.now() - createdAt)
          : -1,
        holderPaths: other.map((t) => path.join(t.root, t.path)),
      };
    }
    db.prepare(
      "INSERT INTO conversation_mutations(id,session_id,owner_session_id,roots_json,paths_json,state,uncertain,created_at,owner_pid,format_version,warning) VALUES (?,?,?,?,?,'open',0,?,?,2,?)",
    ).run(
      id,
      sessionId,
      prepared.owner,
      JSON.stringify(prepared.roots),
      JSON.stringify(prepared.targets),
      new Date().toISOString(),
      process.pid,
      prepared.warning,
    );
    return { id };
  })();
}
/** A writer that gave up. It names the holder, how long the holder has been open
 * and how long we waited, so the model and the UI can decide what to do instead
 * of retrying blind. */
export function mutationBusyError(
  conflict: MutationConflict | null,
  waitedMs: number,
) {
  const detail = conflict
    ? `holder=${conflict.holderSessionId} owner=${conflict.holderOwner} kind=${conflict.kind} age=${conflict.holderAgeMs}ms paths=${conflict.holderPaths.join(",")}`
    : "holder=unknown";
  return Object.assign(
    historyError(
      `Another operation may be writing the same file. Retry after it finishes. [${detail} waited=${waitedMs}ms retryAfterMs=${MUTATION_RETRY_AFTER_MS}]`,
      "FILE_WRITE_BUSY",
    ),
    { retryAfterMs: MUTATION_RETRY_AFTER_MS, conflict },
  );
}
/** Backs off with no lease held. `signal` aborts the sleep so a cancelled run
 * leaves the wait instead of idling out the rest of the budget. */
async function pollDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  const ceiling = Math.min(
    MUTATION_POLL_MAX_MS,
    MUTATION_POLL_MIN_MS * 2 ** Math.min(attempt, 4),
  );
  await delay(Math.round(ceiling * (0.5 + Math.random() / 2)), undefined, {
    signal,
  });
}
/** Runs one native write under a checkpoint mutation, waiting out a competing
 * writer instead of failing on first contact.
 *
 * A lost claim leaves no `open` row and no workspace change, so re-claiming can
 * never replay a native write; the wait is only ever entered before `action()`
 * runs. `paths` are supplied by the native operation, never inferred. */
export async function withCheckpointMutation<T>(
  sessionId: string,
  action: () => T | Promise<T>,
  external = false,
  paths?: string[],
  signal?: AbortSignal,
): Promise<T> {
  const prepared = prepareMutation(
    sessionId,
    external || appendOnlySession(sessionId),
    paths,
  );
  const deadline = Date.now() + mutationWaitBudgetMs(),
    startedAt = Date.now();
  let attempt = 0,
    lastConflict: MutationConflict | null = null,
    recovered = false;
  for (;;) {
    signal?.throwIfAborted();
    // The capture lease spans claim -> before-image -> action -> close. It is
    // deliberately released before the wait: snapshot pruning is admitted only
    // while no capture lease exists, so sleeping under it would stall GC.
    const outcome = await withSnapshotLease(async () => {
      const claim = claimMutation(sessionId, prepared);
      if ("id" in claim)
        return {
          won: true as const,
          value: await recordClaimedMutation(claim.id, action, prepared),
        };
      lastConflict = claim;
      return { won: false as const };
    });
    if (outcome.won) return outcome.value;
    // A holder whose process is gone can never finish. Reaping it here keeps one
    // dead writer from wedging the root until unrelated maintenance happens to run.
    if (!recovered) {
      recovered = true;
      recoverOrphanedCheckpointWriters();
      if (Date.now() < deadline) continue;
    }
    if (Date.now() >= deadline)
      throw mutationBusyError(lastConflict, Date.now() - startedAt);
    await pollDelay(attempt++, signal);
  }
}
/** Completes a claimed mutation: durable before-image, the native write, then the
 * after-image. Runs while the capture lease is still held. */
async function recordClaimedMutation<T>(
  id: string,
  action: () => T | Promise<T>,
  prepared: PreparedMutation,
): Promise<T> {
  const db = getRawSqlite(),
    targets = prepared.targets,
    external = prepared.external;
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
