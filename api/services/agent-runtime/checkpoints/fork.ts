import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_ROOT } from "../../../lib/env.js";
import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeStore } from "../session-store.js";
import { runCommand } from "../tools/exec-async.js";
import { emitRuntimeBusEvent } from "../runtime-bus-bridge.js";
import {
  parseWslUncPath,
  workspaceLocationHostPath,
  type WorkspaceLocation,
} from "../../workspace-location.js";
import { checkpointFiles, sameVersion, excludedSnapshotPath } from "./files.js";
import {
  acquireHistoryLocks,
  releaseHistoryLocks,
  historyError,
  historyRevision,
  sessionRoots,
  activeHistoryOperations,
} from "./guards.js";
import { getCheckpoint, captureCheckpoint } from "./store.js";
import {
  historyAtBoundary,
  cloneHistory,
  insertForkState,
  withoutHistoryJournal,
} from "./state.js";
import { planFileUndo } from "./file-plan.js";
import { recordGitBoundary, committedFileReason } from "./git-boundary.js";
interface ForkDirectory {
  path: string;
  source: string;
  worktree: boolean;
}
export async function forkCheckpoint(
  sessionId: string,
  checkpointId: string,
  revision: number,
  requestId: string,
  includeFiles = true,
): Promise<{ sessionId: string }> {
  const db = getRawSqlite(),
    operationId = `fork_${createHash("sha256").update(`${sessionId}:${requestId}`).digest("hex")}`;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ checkpointId, revision, includeFiles }))
    .digest("hex");
  const old = db
    .prepare(
      "SELECT request_hash,state,result_json FROM conversation_history_operations WHERE id=?",
    )
    .get(operationId) as
    | { request_hash: string; state: string; result_json: string }
    | undefined;
  if (old) {
    if (old.request_hash !== requestHash)
      throw historyError("Fork request ID has different input.");
    if (old.state === "committed") return JSON.parse(old.result_json);
    throw historyError("Recover the previous fork before retrying.");
  }
  const source = agentRuntimeStore.getSession(sessionId),
    backend = source.sessionMetadata?.backend as { id?: string } | undefined;
  if (source.parentSessionId || (backend?.id && backend.id !== "native"))
    throw historyError("Fork requires a native root session.");
  if (historyRevision(sessionId) !== revision)
    throw historyError("Conversation changed. Refresh the preview.");
  const checkpoint = getCheckpoint(sessionId, checkpointId);
  if (checkpoint.kind !== "reply" || checkpoint.payload.version !== 2)
    throw historyError("A reply boundary is required.");
  const roots = sessionRoots(sessionId),
    created: ForkDirectory[] = [];
  const persist = () =>
    db
      .prepare(
        "UPDATE conversation_history_operations SET payload_json=? WHERE id=?",
      )
      .run(
        JSON.stringify({ kind: "fork", ownerPid: process.pid, created }),
        operationId,
      );
  db.transaction(() => {
    acquireHistoryLocks(sessionId, operationId, roots);
    db.prepare(
      "INSERT INTO conversation_history_operations(id,session_id,request_hash,state,payload_json,created_at) VALUES (?,?,?,'fork_preparing',?,?)",
    ).run(
      operationId,
      sessionId,
      requestHash,
      JSON.stringify({ kind: "fork", ownerPid: process.pid, created }),
      new Date().toISOString(),
    );
  })();
  activeHistoryOperations.add(operationId);
  let published = false;
  try {
    const undo = await planFileUndo(checkpoint, includeFiles);
    if (undo.conflicts.length)
      throw historyError(
        "Resolve file conflicts before forking, or choose a newer conversation point.",
      );
    const historical = historyAtBoundary(
        sessionId,
        checkpoint.payload.boundary,
      ),
      mapping = new Map<string, string>();
    // Directory materialization is an explicit fork cost, never a checkpoint cost.
    for (const root of roots) {
      const base = parseWslUncPath(root)
        ? path.join(path.dirname(root), ".synax-forks")
        : path.resolve(DATA_ROOT, "conversation-forks");
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      const destination = path.join(base, randomUUID());
      const head = (await recordGitBoundary(root, "."))?.head;
      created.push({
        path: destination,
        source: root,
        worktree: Boolean(head),
      });
      persist();
      if (head) {
        const result = await runCommand(
          "git",
          [
            "worktree",
            "add",
            "--detach",
            "--no-checkout",
            parseWslUncPath(destination)?.path ?? destination,
            head,
          ],
          { cwd: root, timeoutMs: 30_000 },
        );
        if (result.status !== 0)
          throw new Error(`Cannot create fork worktree: ${result.stderr}`);
        const index = await runCommand("git", ["read-tree", "HEAD"], {
          cwd: destination,
          timeoutMs: 30_000,
        });
        if (index.status !== 0)
          throw new Error("Cannot initialize fork index.");
      } else await fs.mkdir(destination, { mode: 0o700 });
      mapping.set(root, await fs.realpath(destination));
    }
    for (const root of roots) {
      const destination = mapping.get(root)!,
        links: Array<{ relative: string; target: string }> = [];
      await fs.cp(root, destination, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
        filter: async (file) => {
          const relative = path.relative(root, file).split(path.sep).join("/");
          if (
            file === path.resolve(DATA_ROOT) ||
            file === destination ||
            (relative && excludedSnapshotPath(relative))
          )
            return false;
          if ((await fs.lstat(file)).isSymbolicLink()) {
            links.push({
              relative,
              target: path.resolve(path.dirname(file), await fs.readlink(file)),
            });
            return false;
          }
          return true;
        },
      });
      for (const link of links) {
        const owner = roots.find(
          (r) => link.target === r || link.target.startsWith(`${r}${path.sep}`),
        );
        if (!owner)
          throw historyError(
            `External symlink cannot be copied into an isolated fork: ${link.relative}`,
          );
        const target = path.join(
            mapping.get(owner)!,
            path.relative(owner, link.target),
          ),
          file = path.join(destination, link.relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.symlink(path.relative(path.dirname(file), target), file);
      }
    }
    for (const change of undo.changes) {
      if (await committedFileReason(change)) continue;
      const root = mapping.get(change.root);
      if (!root) throw historyError("Workspace binding changed.");
      if (
        !sameVersion(
          await checkpointFiles.version(root, change.path),
          change.after,
        )
      )
        throw historyError(`File changed while creating fork: ${change.path}`);
      await checkpointFiles.write(root, change.path, change.before);
    }
    const mapped = async (value: string, location?: WorkspaceLocation) => {
      const canonical = await fs.realpath(
          location ? workspaceLocationHostPath(location) : value,
        ),
        owner = roots.find(
          (r) => canonical === r || canonical.startsWith(`${r}${path.sep}`),
        );
      if (!owner) throw historyError("Workspace binding changed.");
      return path.join(mapping.get(owner)!, path.relative(owner, canonical));
    };
    for (const row of historical.sessions) {
      const b = JSON.parse(String(row.session_metadata_json ?? "{}"))?.backend;
      if (b?.workDir)
        mapping.set(b.workDir, await mapped(b.workDir, b.workspaceLocation));
    }
    const fork = cloneHistory(historical, sessionId, checkpointId, mapping);
    for (let i = 0; i < fork.state.sessions.length; i++) {
      const row = fork.state.sessions[i],
        meta = JSON.parse(String(row.session_metadata_json)),
        original = JSON.parse(
          String(historical.sessions[i].session_metadata_json ?? "{}"),
        )?.backend,
        b = meta.backend;
      if (b && original?.workDir) {
        b.workDir = await mapped(original.workDir, original.workspaceLocation);
        b.workspaceLocation = parseWslUncPath(b.workDir) ?? {
          kind: "host",
          path: b.workDir,
        };
        b.workspaceRoots = await Promise.all(
          (original.workspaceRoots ?? []).map(
            async (root: { path: string; location?: WorkspaceLocation }) => {
              const location = parseWslUncPath(
                await mapped(root.path, root.location),
              ) ?? {
                kind: "host",
                path: await mapped(root.path, root.location),
              };
              return { ...root, path: location.path, location };
            },
          ),
        );
      }
      delete meta.gitWorkspace;
      meta.fileReadHistoryBoundary = (
        db
          .prepare(
            "SELECT COALESCE(MAX(sequence),0) AS cursor FROM conversation_history_journal",
          )
          .get() as { cursor: number }
      ).cursor;
      row.session_metadata_json = JSON.stringify(meta);
    }
    db.transaction(() => {
      if (historyRevision(sessionId) !== revision)
        throw historyError("Conversation changed while forking.");
      withoutHistoryJournal(() => insertForkState(fork.state));
      db.prepare(
        "UPDATE conversation_history_operations SET state='committed',result_json=? WHERE id=?",
      ).run(JSON.stringify({ sessionId: fork.id }), operationId);
    })();
    published = true;
    const reply = agentRuntimeStore
      .listMessages(fork.id)
      .filter(
        (m) =>
          m.role === "assistant" &&
          m.metadata?.type !== "thinking" &&
          m.metadata?.kind !== "thought",
      )
      .at(-1);
    if (reply)
      await captureCheckpoint(fork.id, "reply", reply.id, reply.stepId);
    emitRuntimeBusEvent({ type: "session_created", sessionId: fork.id });
    return { sessionId: fork.id };
  } finally {
    try {
      if (!published) await recoverForkOperation(operationId, true);
      else releaseHistoryLocks(operationId);
    } finally {
      activeHistoryOperations.delete(operationId);
    }
  }
}
export async function recoverForkOperation(
  id: string,
  internal = false,
): Promise<void> {
  const db = getRawSqlite(),
    row = db
      .prepare(
        "SELECT state,payload_json FROM conversation_history_operations WHERE id=?",
      )
      .get(id) as { state: string; payload_json: string } | undefined;
  if (!row || ["committed", "aborted"].includes(row.state)) return;
  const payload = JSON.parse(row.payload_json) as {
    ownerPid: number;
    created: ForkDirectory[];
  };
  if (!internal) {
    if (activeHistoryOperations.has(id))
      throw historyError("Fork is still running.");
    if (row.state !== "recovery_required" && payload.ownerPid !== process.pid) {
      let alive = true;
      try {
        process.kill(payload.ownerPid, 0);
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive) throw historyError("Fork is owned by a live process.");
    }
  }
  try {
    for (const directory of [...payload.created].reverse()) {
      if (directory.worktree) {
        const result = await runCommand(
          "git",
          [
            "worktree",
            "remove",
            "--force",
            parseWslUncPath(directory.path)?.path ?? directory.path,
          ],
          { cwd: directory.source, timeoutMs: 30_000 },
        );
        if (
          result.status !== 0 &&
          (await fs.stat(directory.path).catch(() => null))
        )
          throw new Error(`Cannot remove unpublished fork: ${directory.path}`);
      } else await fs.rm(directory.path, { recursive: true, force: true });
    }
    db.transaction(() => {
      db.prepare(
        "UPDATE conversation_history_operations SET state='aborted' WHERE id=?",
      ).run(id);
      releaseHistoryLocks(id);
    })();
  } catch (error) {
    db.prepare(
      "UPDATE conversation_history_operations SET state='recovery_required' WHERE id=?",
    ).run(id);
    throw error;
  }
}
