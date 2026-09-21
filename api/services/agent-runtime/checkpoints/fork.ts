import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_ROOT } from "../../../lib/env.js";
import { getRawSqlite } from "../../../db/index.js";
import { runCommand } from "../tools/exec-async.js";
import { agentRuntimeStore } from "../session-store.js";
import { emitRuntimeBusEvent } from "../runtime-bus-bridge.js";
import { parseWslUncPath, workspaceLocationHostPath, type WorkspaceLocation } from "../../workspace-location.js";
import { checkpointFiles } from "./files.js";
import {
  acquireHistoryLocks,
  activeHistoryOperations,
  historyError,
  historyRevision,
  releaseHistoryLocks,
  sessionRoots,
} from "./guards.js";
import { cloneHistory, insertForkState } from "./state.js";
import { captureCheckpoint, getCheckpoint } from "./store.js";

export async function forkCheckpoint(
  sessionId: string,
  checkpointId: string,
  revision: number,
  requestId: string,
): Promise<{ sessionId: string }> {
  const db = getRawSqlite(),
    operationId = `fork_${createHash("sha256").update(`${sessionId}:${requestId}`).digest("hex")}`;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ checkpointId, revision }))
    .digest("hex");
  const existing = db
    .prepare(
      "SELECT request_hash,state,result_json FROM conversation_history_operations WHERE id=?",
    )
    .get(operationId) as
    | { request_hash: string; state: string; result_json: string }
    | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw historyError("Fork request ID was used for another checkpoint.");
    if (existing.state === "committed") return JSON.parse(existing.result_json);
    throw historyError(
      "The previous fork did not finish. Use a new request ID.",
    );
  }
  const source = agentRuntimeStore.getSession(sessionId),
    backend = source.sessionMetadata?.backend as { id?: string } | undefined;
  if (source.parentSessionId || (backend?.id && backend.id !== "native"))
    throw historyError("Fork currently requires a native root session.");
  if (historyRevision(sessionId) !== revision)
    throw historyError("Conversation changed. Refresh before forking.");
  const checkpoint = getCheckpoint(sessionId, checkpointId);
  if (
    checkpoint.kind !== "reply" ||
    checkpoint.payload.error ||
    !checkpoint.payload.manifests ||
    !checkpoint.payload.history
  )
    throw historyError("A complete reply checkpoint is required.");
  const manifests = checkpoint.payload.manifests;
  const roots = sessionRoots(sessionId);
  const created: Array<{ path: string; source: string; worktree: boolean }> =
    [];
  const persistProgress = () =>
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
    const mapping = new Map<string, string>();
    // Prepare every destination before publishing any session records.
    for (const manifest of manifests) {
      const wsl = parseWslUncPath(manifest.root);
      const base = wsl
        ? path.join(path.dirname(manifest.root), ".synax-forks")
        : path.resolve(DATA_ROOT, "conversation-forks");
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      const destination = path.join(base, randomUUID());
      created.push({
        path: destination,
        source: manifest.root,
        worktree: Boolean(manifest.gitHead),
      });
      persistProgress();
      if (manifest.gitHead) {
        const result = await runCommand(
          "git",
          [
            "worktree",
            "add",
            "--detach",
            "--no-checkout",
            parseWslUncPath(destination)?.path ?? destination,
            manifest.gitHead,
          ],
          { cwd: manifest.root, timeoutMs: 30_000 },
        );
        if (result.status !== 0)
          throw new Error(`Cannot create isolated worktree: ${result.stderr}`);

        const index = await runCommand("git", ["read-tree", "HEAD"], {
          cwd: destination,
          timeoutMs: 30_000,
        });
        if (index.status !== 0)
          throw new Error("Cannot initialize fork index.");
      } else {
        await fs.mkdir(destination, { mode: 0o700 });
      }
      mapping.set(manifest.root, await fs.realpath(destination));
    }
    for (const manifest of manifests) {
      const destination = mapping.get(manifest.root)!;
      for (const [relative, original] of Object.entries(manifest.files)) {
        let version = original;
        if (version.kind === "symlink") {
          const link = (await checkpointFiles.get(version.hash)).toString();
          const resolved = path.resolve(
            path.dirname(path.join(manifest.root, relative)),
            link,
          );
          const owner = [...mapping.keys()].find(
            (root) =>
              resolved === root || resolved.startsWith(`${root}${path.sep}`),
          );
          if (!owner)
            throw historyError(
              `Fork would contain an external symlink: ${relative}. Remove or relocate it before creating a fork.`,
            );
          const target = path.join(
            mapping.get(owner)!,
            path.relative(owner, resolved),
          );
          version = {
            ...version,
            hash: await checkpointFiles.put(
              Buffer.from(
                path.relative(
                  path.dirname(path.join(destination, relative)),
                  target,
                ),
              ),
            ),
          };
        }
        await checkpointFiles.write(destination, relative, version);
      }
    }
    // Location identity includes the WSL distribution; Linux path strings alone
    // are ambiguous when two referenced roots live in different distributions.
    const mappedDirectory = async (value: string, location?: WorkspaceLocation): Promise<string> => {
      const canonical = await fs.realpath(location ? workspaceLocationHostPath(location) : value);
      const owner = [...mapping.keys()].find(root => canonical === root || canonical.startsWith(`${root}${path.sep}`));
      if (!owner) throw historyError("A historical workspace binding is outside the captured roots.");
      return path.join(mapping.get(owner)!, path.relative(owner, canonical));
    };
    for (const row of checkpoint.payload.history.sessions) {
      const binding = JSON.parse(String(row.session_metadata_json))?.backend;
      if (binding?.workDir) mapping.set(binding.workDir, await mappedDirectory(binding.workDir, binding.workspaceLocation));
    }
    const fork = cloneHistory(checkpoint.payload.history, sessionId, checkpointId, mapping);
    for (let index = 0; index < fork.state.sessions.length; index++) {
      const row = fork.state.sessions[index];
      const metadata = JSON.parse(String(row.session_metadata_json));
      const original = JSON.parse(String(checkpoint.payload.history.sessions[index].session_metadata_json))?.backend;
      const binding = metadata.backend;
      if (binding && original?.workDir) {
        binding.workDir = await mappedDirectory(original.workDir, original.workspaceLocation);
        binding.workspaceLocation = parseWslUncPath(binding.workDir) ?? { kind: "host", path: binding.workDir };
        binding.workspaceRoots = await Promise.all((original.workspaceRoots ?? []).map(async (root: {path: string; location?: WorkspaceLocation}) => {
          const directory = await mappedDirectory(root.path, root.location);
          const location = parseWslUncPath(directory) ?? { kind: "host" as const, path: directory };
          return { ...root, path: location.path, location };
        }));
      }
      delete metadata.gitWorkspace;
      row.session_metadata_json = JSON.stringify(metadata);
    }
    db.transaction(() => {
      if (historyRevision(sessionId) !== revision)
        throw historyError("Conversation changed while preparing fork.");
      insertForkState(fork.state);
      db.prepare(
        "UPDATE conversation_history_operations SET state='committed',result_json=? WHERE id=?",
      ).run(JSON.stringify({ sessionId: fork.id }), operationId);
    })();
    published = true;
    const reply = agentRuntimeStore
      .listMessages(fork.id)
      .filter((m) => m.role === "assistant")
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
  operationId: string,
  internal = false,
): Promise<void> {
  const db = getRawSqlite();
  const row = db
    .prepare(
      "SELECT state,payload_json FROM conversation_history_operations WHERE id=?",
    )
    .get(operationId) as { state: string; payload_json: string } | undefined;
  if (!row || row.state === "committed" || row.state === "aborted") return;
  const payload = JSON.parse(row.payload_json) as {
    ownerPid: number;
    created: Array<{ path: string; source: string; worktree: boolean }>;
  };
  if (!internal) {
    if (activeHistoryOperations.has(operationId))
      throw historyError("Fork operation is still running.");
    if (row.state !== "recovery_required" && payload.ownerPid !== process.pid) {
      let alive = true;
      try {
        process.kill(payload.ownerPid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive) throw historyError("Fork is owned by a live process.");
    }
  }
  try {
    for (const item of [...payload.created].reverse()) {
      if (item.worktree) {
        const removed = await runCommand(
          "git",
          [
            "worktree",
            "remove",
            "--force",
            parseWslUncPath(item.path)?.path ?? item.path,
          ],
          { cwd: item.source, timeoutMs: 30_000 },
        );
        if (
          removed.status !== 0 &&
          (await fs.stat(item.path).catch(() => null))
        )
          throw new Error(`Cannot clean up unpublished worktree: ${item.path}`);
      } else await fs.rm(item.path, { recursive: true, force: true });
    }
    db.transaction(() => {
      db.prepare(
        "UPDATE conversation_history_operations SET state='aborted' WHERE id=?",
      ).run(operationId);
      releaseHistoryLocks(operationId);
    })();
  } catch (error) {
    db.prepare(
      "UPDATE conversation_history_operations SET state='recovery_required' WHERE id=?",
    ).run(operationId);
    throw error;
  }
}
