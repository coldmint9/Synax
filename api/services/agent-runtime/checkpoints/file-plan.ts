import {
  mutationPages,
  mutationHighWater,
  FilePlanBudget,
} from "./mutation-pages.js";
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
/** Only declared session writes participate. Unrelated directory changes are never scanned. */
export async function planFileUndo(
  checkpoint: ConversationCheckpoint,
  includeFiles = true,
): Promise<FileUndoPlan> {
  const db = getRawSqlite(),
    owner = rootOwner(checkpoint.sessionId);
  expireFileUndo(Date.now(), checkpoint.sessionId);
  const highWater = mutationHighWater(),
    budget = new FilePlanBudget();
  const warningValues = new Set<string>(),
    preservedValues = new Map<string, PreservedFile>(),
    conflictValues = new Map<string, FileConflict>();
  const warnings = {
    add(value: string) {
      if (!warningValues.has(value)) {
        budget.replace(undefined, value);
        warningValues.add(value);
      }
    },
  };
  const preservedFiles = {
    push(value: PreservedFile) {
      const key = JSON.stringify([value.root, value.path, value.kind]);
      budget.replace(preservedValues.get(key), value);
      preservedValues.set(key, value);
    },
  };
  const conflicts = {
    push(...values: FileConflict[]) {
      for (const value of values) {
        const key = JSON.stringify([value.root, value.path, value.reason]);
        budget.replace(conflictValues.get(key), value);
        conflictValues.set(key, value);
      }
    },
  };
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
  let gitCacheBytes = 0;
  for await (const row of mutationPages(
    owner,
    checkpoint.mutationCursor,
    highWater,
  )) {
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
        const key = JSON.stringify([file.root, file.path]);
        budget.replace(byPath.get(key), undefined);
        byPath.delete(key);
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
        const size = Buffer.byteLength(gitKey);
        while (
          gitChecks.size &&
          (gitChecks.size >= 128 || gitCacheBytes + size > 128 * 1024)
        ) {
          const oldest = gitChecks.keys().next().value!;
          gitChecks.delete(oldest);
          gitCacheBytes -= Buffer.byteLength(oldest);
        }
        if (size <= 128 * 1024) {
          gitChecks.set(gitKey, commit);
          gitCacheBytes += size;
        }
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
        budget.replace(byPath.get(key), undefined);
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
      const next = previous ? { ...previous, after: c.after } : c;
      budget.replace(previous, next);
      byPath.set(key, next);
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
  const changedPaths = new Set(changes.map((c) => path.join(c.root, c.path)));
  if (changes.length)
    for await (const foreign of mutationPages(
      owner,
      checkpoint.mutationCursor,
      highWater,
      true,
    )) {
      const paths = JSON.parse(foreign.paths_json) as {
        root: string;
        path: string;
      }[];
      const files = paths.length
        ? paths
        : (JSON.parse(foreign.changes_json) as FileChange[]);
      for (const other of files)
        if (changedPaths.has(path.join(other.root, other.path)))
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
    conflicts: [...conflictValues.values()],
    warnings: [...warningValues],
    preservedFiles: [...preservedValues.values()].map(
      ({ root, path, kind, reason }) => ({ root, path, kind, reason }),
    ),
  };
}
