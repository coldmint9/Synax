import path from "node:path";
import { getRawSqlite } from "../../../db/index.js";
import {
  checkpointFiles,
  sameVersion,
  type FileChange,
  type FileConflict,
} from "./files.js";
import { fileGitPreservation, type GitPreservation } from "./git-boundary.js";
import { rootOwner, sessionRoots } from "./guards.js";
import { expireFileUndo } from "./retention.js";
import type { ConversationCheckpoint } from "./store.js";
export interface PreservedFile {
  root: string;
  path: string;
  reason: string;
  kind: "committed" | "git_unverified" | "expired" | "untracked" | "workspace";
}
export interface FileUndoPlan {
  changes: FileChange[];
  conflicts: FileConflict[];
  warnings: string[];
  preservedFiles: PreservedFile[];
}
interface Mutation {
  id: string;
  sequence: number;
  owner_session_id: string;
  roots_json: string;
  paths_json: string;
  changes_json: string;
  state: string;
  uncertain: number;
  format_version: number;
  warning: string | null;
}
/** Only declared session writes participate. Unrelated directory changes are never scanned. */
export async function planFileUndo(
  checkpoint: ConversationCheckpoint,
  includeFiles = true,
): Promise<FileUndoPlan> {
  const db = getRawSqlite(),
    owner = rootOwner(checkpoint.sessionId);
  expireFileUndo();
  const records = db
    .prepare(
      "SELECT * FROM conversation_mutations WHERE sequence>? AND state<>'reverted' ORDER BY sequence",
    )
    .all(checkpoint.mutationCursor) as Mutation[];
  const ours = records.filter((r) => r.owner_session_id === owner);
  const warnings = new Set<string>(),
    preservedFiles: PreservedFile[] = [],
    conflicts: FileConflict[] = [];
  if (checkpoint.payload.boundary.legacy)
    warnings.add(
      "This older checkpoint has a transcript boundary only. Historical file changes that were not reliably recorded are preserved.",
    );
  const byPath = new Map<string, FileChange>();
  let roots: string[] = [];
  if (includeFiles)
    try {
      roots = sessionRoots(checkpoint.sessionId);
    } catch {
      /* Transcript trimming does not require an accessible project directory. */
    }
  const gitChecks = new Map<string, Promise<GitPreservation | null>>();
  for (const row of ours) {
    const entries = JSON.parse(row.changes_json) as FileChange[];
    const paths = JSON.parse(row.paths_json) as {
      root: string;
      path: string;
    }[];
    if (row.warning) warnings.add(row.warning);
    const unavailable =
      row.state === "expired" ||
      row.format_version < 2 ||
      row.uncertain ||
      row.state === "open";
    if (unavailable) {
      const kind = row.state === "expired" ? "expired" : "untracked";
      const reason =
        kind === "expired"
          ? "File undo expired after 24 hours without an active visit."
          : "File ownership was not reliably recorded; the file is preserved.";
      warnings.add(reason);
      for (const file of paths.length ? paths : entries) {
        byPath.delete(JSON.stringify([file.root, file.path]));
        preservedFiles.push({ ...file, kind, reason });
      }
      continue;
    }
    let changed = false;
    for (const c of entries) {
      const key = JSON.stringify([c.root, c.path]);
      if (c.preserved === "committed") {
        preservedFiles.push({
          root: c.root,
          path: c.path,
          kind: "committed",
          reason:
            "This file has been committed to Git; committed changes are preserved.",
        });
        continue;
      }
      const gitKey = JSON.stringify([c.root, c.path, c.git]);
      let commit = gitChecks.get(gitKey);
      if (!commit) {
        commit = fileGitPreservation(c);
        gitChecks.set(gitKey, commit);
      }
      const preservation = await commit;
      if (preservation) {
        preservedFiles.push({
          root: c.root,
          path: c.path,
          ...preservation,
        });
        // Once observed committed, it is a permanent file-undo boundary. Later
        // checkouts cannot resurrect old before-images as uncommitted changes.
        byPath.delete(key);
        if (preservation.kind === "committed") {
          c.before = null;
          c.after = null;
          c.preserved = "committed";
          changed = true;
        }
        continue;
      }
      if (!includeFiles) continue;
      if (!roots.includes(c.root)) {
        preservedFiles.push({
          root: c.root,
          path: c.path,
          kind: "workspace",
          reason: "Workspace binding changed; file is preserved.",
        });
        continue;
      }
      const previous = byPath.get(key);
      if (previous && !sameVersion(previous.after, c.before))
        conflicts.push({
          root: c.root,
          path: c.path,
          reason: "Independent changes occurred between these writes.",
        });
      byPath.set(key, previous ? { ...previous, after: c.after } : c);
    }
    if (changed)
      db.prepare(
        "UPDATE conversation_mutations SET changes_json=? WHERE id=?",
      ).run(JSON.stringify(entries), row.id);
  }
  const changes = [...byPath.values()].filter(
    (c) => !sameVersion(c.before, c.after),
  );
  // Other sessions and the human editor have separate ownership. Even an
  // identical-content write is not permission to undo their work.
  for (const foreign of records.filter((r) => r.owner_session_id !== owner)) {
    const paths = JSON.parse(foreign.paths_json) as {
      root: string;
      path: string;
    }[];
    const files = paths.length
      ? paths
      : (JSON.parse(foreign.changes_json) as FileChange[]);
    for (const other of files)
      if (
        changes.some(
          (c) =>
            path.join(c.root, c.path) === path.join(other.root, other.path),
        )
      )
        conflicts.push({
          root: other.root,
          path: other.path,
          reason: "Another session or the user also wrote this file.",
        });
  }
  if (includeFiles)
    conflicts.push(...(await checkpointFiles.verify(changes, "after")));
  return {
    changes,
    conflicts,
    warnings: [...warnings],
    preservedFiles: [
      ...new Map(
        preservedFiles.map((f) => [
          `${f.root}/${f.path}:${f.kind}`,
          { root: f.root, path: f.path, kind: f.kind, reason: f.reason },
        ]),
      ).values(),
    ],
  };
}
