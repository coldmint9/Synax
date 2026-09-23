import type { RuntimeWrite } from "./version-runtime/batch-input.js";
import fs from "node:fs/promises";
import {
  workspaceLocationHostPath,
  type WorkspaceLocation,
} from "../../workspace-location.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setImmediate as yieldNow } from "node:timers/promises";
import { getRawSqlite } from "../../../db/index.js";
import {
  agentRuntimeStore as store,
  mapLegacyHistoryRow,
} from "../session-store.js";
import type { AgentSession, CompactionRecord } from "../contracts.js";
import { rebuildSessionPermissionRules } from "../session-permissions.js";
import { profileService } from "../profile-service.js";
import { initializeGoal } from "../goal-control.js";
import { emitRuntimeBusEvent } from "../runtime-bus-bridge.js";
import { makeBackendBinding } from "../backends/backend-binding.js";
import {
  versionRepository,
  historySessionFields,
  appendOnlySession,
} from "./version-runtime/bridge.js";
import { VersionHeads } from "./version-store/heads.js";
import { VersionCollector } from "./version-store/gc.js";
import { hashBytes } from "./version-store/hash-codec.js";
import { getCheckpoint } from "./store.js";
import {
  activeHistoryOperations,
  assertHistoryIdle,
  assertHistoryUnlocked,
  historyError,
  historyRevision,
  sessionRoots,
} from "./guards.js";
import {
  createForkWorkspace,
  inspectForkWorkspace,
  removeForkWorkspace,
  type ForkWorkspace,
  type ForkWorkspaceMode,
} from "./fork-workspace.js";

interface CopySource {
  session: AgentSession;
  messageId: string;
  versionId?: string;
  stopAtMessage: boolean;
  legacySequence?: number;
  legacyRowid?: number;
}
interface ForkJob {
  kind: "simple-fork";
  ownerPid: number;
  targetId: string;
  readerId: string;
  workspace?: ForkWorkspace;
}
let copying = false;
let inspecting = false;
function resolveSource(sessionId: string, checkpointId: string): CopySource {
  const session = store.getSession(sessionId);
  if (
    session.parentSessionId ||
    ((session.sessionMetadata?.backend as { id?: string })?.id ?? "native") !==
      "native"
  )
    throw historyError("Fork requires a Native root conversation.");
  if (checkpointId.startsWith("message:") && appendOnlySession(sessionId)) {
    const messageId = checkpointId.slice(8),
      repo = versionRepository();
    const ref = repo.recordReference(sessionId, "messages", messageId);
    const message = ref
      ? repo.records.read(ref, 8192, ["role", "metadata"])
      : undefined;
    if (
      !message ||
      message.role !== "assistant" ||
      (message.metadata as Record<string, unknown>)?.partial
    )
      throw historyError("A visible completed reply is required.");
    return {
      session,
      messageId,
      versionId: repo.head(sessionId).versionId,
      stopAtMessage: true,
    };
  }
  const checkpoint = getCheckpoint(sessionId, checkpointId);
  if (checkpoint.kind !== "reply" || !checkpoint.messageId)
    throw historyError("A reply boundary is required.");
  if (checkpoint.payload.version === 3)
    return {
      session,
      messageId: checkpoint.messageId,
      versionId: checkpoint.payload.versionId!,
      stopAtMessage: false,
    };
  const message = getRawSqlite()
    .prepare(
      "SELECT sequence,rowid AS rowid FROM agent_runtime_messages WHERE session_id=? AND id=? AND role='assistant'",
    )
    .get(sessionId, checkpoint.messageId) as
    | { sequence: number; rowid: number }
    | undefined;
  if (!message) throw historyError("The selected reply is no longer visible.");
  return {
    session,
    messageId: checkpoint.messageId,
    stopAtMessage: true,
    legacySequence: message.sequence,
    legacyRowid: message.rowid,
  };
}
function workDir(session: AgentSession): string {
  const directory =
    (session.sessionMetadata?.backend as { workDir?: string })?.workDir ??
    sessionRoots(session.id)[0];
  if (!directory)
    throw historyError("A workspace is required to fork this conversation.");
  return directory;
}

export async function previewSimpleFork(
  sessionId: string,
  checkpointId: string,
  mode: ForkWorkspaceMode,
) {
  assertHistoryUnlocked(sessionId, []);
  assertHistoryIdle(sessionId);
  const source = resolveSource(sessionId, checkpointId);
  const revision = historyRevision(sessionId);
  if (mode === "new_worktree") {
    if (inspecting)
      throw historyError(
        "A worktree preview is already being checked. Retry shortly.",
        "FORK_BUSY",
      );
    inspecting = true;
    try {
      await inspectForkWorkspace(sessionId, workDir(source.session));
    } finally {
      inspecting = false;
    }
  }
  return {
    checkpointId,
    revision,
    removedMessages: 0,
    files: [],
    conflicts: [],
    preservedFiles: [],
    canApply: true,
    workspaceMode: mode,
    rollbackEnabled: false,
    exclusions:
      "No execution history, pending authorizations, checkpoints or file undo is copied.",
    warnings: [
      mode === "new_worktree"
        ? "New worktree starts at the current Git commit. Uncommitted/ignored files, checkout filters and submodules are not copied."
        : "Both conversations use the same working directory. File writes are shared.",
      "The fork is append-only: rollback and editing earlier messages are disabled. Plans and execution state are rebuilt.",
    ],
  };
}
async function cloneSession(
  source: AgentSession,
  history: Record<string, unknown>,
  id: string,
  checkpointId: string,
  mode: ForkWorkspaceMode,
  workspace?: ForkWorkspace,
): Promise<AgentSession> {
  const oldMetadata =
    (history.sessionMetadata as Record<string, unknown>) ?? {};
  const metadata: Record<string, unknown> = {};
  for (const key of [
    "mode",
    "userPrompt",
    "goalContent",
    "language",
    "permissionTier",
    "permissionOverrides",
  ])
    if (oldMetadata[key] !== undefined) metadata[key] = oldMetadata[key];
  // Permissions are current user policy, never restored approval records.
  for (const key of ["permissionTier", "permissionOverrides"])
    if (source.sessionMetadata?.[key] !== undefined)
      metadata[key] = source.sessionMetadata[key];
  const previous = source.sessionMetadata?.backend as
    | {
        model?: string;
        workspaceLocation?: unknown;
        workspaceRoots?: Array<{ path: string; location?: unknown }>;
      }
    | undefined;
  const backend = {
    ...makeBackendBinding(
      "native",
      previous?.model ?? null,
      workspace?.workDir ?? workDir(source),
    ),
  } as Record<string, unknown>;
  if (workspace) {
    backend.workspaceLocation = { kind: "host", path: workspace.workDir };
    if (previous?.workspaceRoots)
      backend.workspaceRoots = await Promise.all(
        previous.workspaceRoots.map(async (root) => {
          const canonical = await fs.realpath(
            root.location
              ? workspaceLocationHostPath(root.location as WorkspaceLocation)
              : root.path,
          );
          const relative = path.relative(workspace.source, canonical);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            throw historyError("Workspace roots changed during fork.");
          const next = path.join(workspace.path, relative);
          return {
            ...root,
            path: next,
            location: { kind: "host", path: next },
          };
        }),
      );
  } else {
    if (previous?.workspaceLocation)
      backend.workspaceLocation = previous.workspaceLocation;
    if (previous?.workspaceRoots)
      backend.workspaceRoots = previous.workspaceRoots;
  }
  metadata.backend = backend;
  metadata.fork = {
    sourceSessionId: source.id,
    sourceCreatedAt:
      (source.sessionMetadata?.fork as { sourceCreatedAt?: string } | undefined)
        ?.sourceCreatedAt ?? source.createdAt,
    checkpointId,
    workspaceMode: mode,
    appendOnly: true,
    ...(workspace ? { commit: workspace.commit, path: workspace.path } : {}),
  };
  if (metadata.mode === "goal")
    metadata.goal = initializeGoal(
      String(metadata.userPrompt ?? history.prompt ?? source.prompt),
    );
  const now = new Date().toISOString();
  const session: AgentSession = {
    ...source,
    id,
    parentSessionId: null,
    childSessionIds: [],
    status: "completed",
    title: `${source.title ?? "Conversation"} · Fork`,
    prompt: String(history.prompt ?? source.prompt),
    resultSummary:
      typeof history.resultSummary === "string" ? history.resultSummary : null,
    contextSnapshotId: null,
    activeRunId: null,
    pendingResumeToken: null,
    blockedReason: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    sessionMetadata: metadata,
    permissionRules: [],
  };
  session.permissionRules = rebuildSessionPermissionRules(
    session,
    profileService.getForSession(source).permissionDefaults,
  );
  return session;
}
async function dropHead(id: string): Promise<void> {
  const db = getRawSqlite();
  for (;;) {
    const result = db
      .prepare(
        "DELETE FROM conversation_v3_owned_versions WHERE session_id=? AND version_id IN (SELECT version_id FROM conversation_v3_owned_versions WHERE session_id=? LIMIT 64)",
      )
      .run(id, id);
    if (!result.changes) break;
    await yieldNow();
  }
  db.prepare("DELETE FROM conversation_v3_heads WHERE session_id=?").run(id);
}
function copyAssetReferences(
  sourceId: string,
  targetId: string,
  sourceRef: string,
  targetRef: string,
): void {
  const db = getRawSqlite(),
    repo = versionRepository();
  const assets = db
    .prepare(
      `SELECT r.asset_id,a.project_id,(SELECT project_id FROM agent_runtime_sessions WHERE id=?) AS allowed_project
    FROM conversation_v3_asset_refs r LEFT JOIN agent_runtime_assets a ON a.id=r.asset_id WHERE r.object_hash=? LIMIT 11`,
    )
    .all(sourceId, hashBytes(sourceRef)) as {
    asset_id: string;
    project_id: string | null;
    allowed_project: string | null;
  }[];
  if (assets.length > 10)
    throw historyError("Message media reference budget exceeded.");
  for (const asset of assets) {
    if (!asset.project_id || asset.project_id !== asset.allowed_project)
      throw historyError(
        "A copied attachment is missing or belongs to another project.",
      );
    if (!repo.recordReference(targetId, "assets", asset.asset_id))
      repo.put(targetId, "assets", asset.asset_id, {
        assetId: asset.asset_id,
        projectId: asset.project_id,
      });
    for (const ref of [
      targetRef,
      repo.recordReference(targetId, "assets", asset.asset_id)!,
    ])
      db.prepare(
        "INSERT OR IGNORE INTO conversation_v3_asset_refs(object_hash,asset_id) VALUES(?,?)",
      ).run(hashBytes(ref), asset.asset_id);
  }
}
/** Bounded transcript copy. The source is frozen/pinned, and the target's raw
 * session row is inserted only after every message and attachment is durable. */
export async function forkSimpleConversation(
  sessionId: string,
  checkpointId: string,
  revision: number,
  requestId: string,
  mode: ForkWorkspaceMode,
): Promise<{
  sessionId: string;
  workspaceMode: ForkWorkspaceMode;
  rollbackEnabled: false;
}> {
  const db = getRawSqlite(),
    repo = versionRepository();
  const operationId = `fork_${createHash("sha256").update(`${sessionId}:${requestId}`).digest("hex")}`;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ checkpointId, revision, workspaceMode: mode }))
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
    if (old.state !== "aborted")
      throw historyError(
        "Recover the unfinished fork before retrying.",
        "HISTORY_RECOVERY_REQUIRED",
      );
  }
  if (copying)
    throw historyError(
      "Another fork is being copied. Retry shortly.",
      "FORK_BUSY",
    );
  copying = true;
  let job: ForkJob | undefined,
    published = false,
    prepared = false;
  activeHistoryOperations.add(operationId);
  try {
    assertHistoryUnlocked(sessionId, []);
    assertHistoryIdle(sessionId);
    if (historyRevision(sessionId) !== revision)
      throw historyError(
        "Conversation changed. Refresh the preview.",
        "HISTORY_STALE",
      );
    const source = resolveSource(sessionId, checkpointId);
    const targetId = `ars_${randomUUID()}`,
      readerId = `forkview_${operationId}`;
    job = { kind: "simple-fork", ownerPid: process.pid, targetId, readerId };
    db.transaction(() => {
      if (old)
        db.prepare(
          "DELETE FROM conversation_history_operations WHERE id=? AND state='aborted'",
        ).run(operationId);
      db.prepare(
        "INSERT INTO conversation_history_operations(id,session_id,request_hash,state,payload_json,created_at) VALUES(?,?,?,'fork_preparing',?,?)",
      ).run(
        operationId,
        sessionId,
        requestHash,
        JSON.stringify(job),
        new Date().toISOString(),
      );
      if (source.versionId)
        new VersionHeads(db, repo.objects).create(readerId, source.versionId);
    })();
    prepared = true;
    if (
      source.versionId &&
      !repo.recordReference(readerId, "messages", source.messageId)
    )
      throw historyError("Selected reply is not present in its snapshot.");
    if (mode === "new_worktree") {
      const info = await inspectForkWorkspace(
        sessionId,
        workDir(source.session),
      );
      job.workspace = await createForkWorkspace(info, targetId, (workspace) => {
        job!.workspace = workspace;
        db.prepare(
          "UPDATE conversation_history_operations SET payload_json=? WHERE id=?",
        ).run(JSON.stringify(job), operationId);
      });
    }
    const history = source.versionId
      ? repo.readSession(readerId)
      : historySessionFields(source.session);
    const target = await cloneSession(
      source.session,
      history,
      targetId,
      checkpointId,
      mode,
      job.workspace,
    );
    if (!source.versionId || source.stopAtMessage) {
      // No historical state snapshot exists for a virtual/legacy message anchor.
      // Keep the transcript, but rebuild decision state rather than importing future progress.
      target.resultSummary = null;
      for (const key of ["goal", "goalContent"])
        delete target.sessionMetadata?.[key];
    }
    db.transaction(() => {
      repo.create(targetId, historySessionFields(target));
      db.prepare(
        "UPDATE conversation_v3_heads SET runtime_mode='native',boundary_only=1,rollback_enabled=0 WHERE session_id=?",
      ).run(targetId);
    })();
    let cursor: string | undefined,
      afterSequence = -1,
      afterRow = 0,
      found = false;
    do {
      if (source.versionId) {
        const page = repo.page(readerId, "messages", {
          limit: 16,
          cursor,
          fields: ["id", "role"],
        });
        db.transaction(() => {
          const writes: RuntimeWrite[] = [];
          const copied: { id: string; ref: string }[] = [];
          for (const message of page.items) {
            const id = `msg_${randomUUID()}`,
              ref = repo.recordReference(
                readerId,
                "messages",
                String(message.id),
              )!;
            let metadata: Record<string, unknown> = {};
            try {
              metadata =
                (repo.records.read(ref, 8192, ["metadata"]).metadata as Record<
                  string,
                  unknown
                >) ?? {};
            } catch (error) {
              if ((error as { code?: string }).code !== "VERSION_RECORD_BUDGET")
                throw error;
            }
            writes.push({
              table: "messages",
              id,
              copyFrom: ref,
              fields: {
                id,
                sessionId: targetId,
                runId: null,
                stepId: null,
                metadata: {
                  source: metadata.source,
                  purpose: metadata.purpose,
                  forkedFromMessageId: message.id,
                },
              },
            });
            copied.push({ id, ref });
            if (source.stopAtMessage && message.id === source.messageId) {
              found = true;
              break;
            }
          }
          repo.putBatch(targetId, writes);
          for (const item of copied)
            copyAssetReferences(
              sessionId,
              targetId,
              item.ref,
              repo.recordReference(targetId, "messages", item.id)!,
            );
        })();
        cursor = found ? undefined : page.next;
        if (!cursor) break;
      } else {
        const rows = db
          .prepare(
            `SELECT rowid AS rowid,sequence,id,length(CAST(content AS BLOB))+COALESCE(length(CAST(metadata_json AS BLOB)),0)+COALESCE(length(CAST(content_parts_json AS BLOB)),0) AS bytes
          FROM agent_runtime_messages WHERE session_id=? AND (sequence>? OR (sequence=? AND rowid>?))
          AND (sequence<? OR (sequence=? AND rowid<=?)) ORDER BY sequence,rowid LIMIT 16`,
          )
          .all(
            sessionId,
            afterSequence,
            afterSequence,
            afterRow,
            source.legacySequence!,
            source.legacySequence!,
            source.legacyRowid!,
          ) as { rowid: number; sequence: number; id: string; bytes: number }[];
        if (!rows.length) break;
        let bytes = 0;
        db.transaction(() => {
          for (const row of rows) {
            if (row.bytes > 768 * 1024)
              throw historyError(
                "Legacy message exceeds the bounded copy budget; the source conversation was left unchanged.",
                "HISTORY_PAGE_REQUIRED",
              );
            if (bytes && bytes + row.bytes > 768 * 1024) break;
            bytes += row.bytes;
            const raw = db
              .prepare(
                "SELECT id,session_id,run_id,step_id,role,content,content_parts_json,metadata_json,created_at FROM agent_runtime_messages WHERE session_id=? AND rowid=?",
              )
              .get(sessionId, row.rowid) as Record<string, unknown>;
            const fields = mapLegacyHistoryRow("agent_runtime_messages", raw),
              metadata = fields.metadata as Record<string, unknown>;
            const id = `msg_${randomUUID()}`;
            repo.put(targetId, "messages", id, {
              ...fields,
              id,
              sessionId: targetId,
              runId: null,
              stepId: null,
              metadata: {
                source: metadata.source,
                purpose: metadata.purpose,
                forkedFromMessageId: row.id,
              },
            });
            const ref = repo.recordReference(targetId, "messages", id)!;
            for (const part of (fields.contentParts as
              | { type: string; assetId?: string }[]
              | undefined) ?? []) {
              if (part.type === "text" || !part.assetId) continue;
              const asset = db
                .prepare(
                  "SELECT id,project_id FROM agent_runtime_assets WHERE id=? AND project_id=?",
                )
                .get(part.assetId, source.session.projectId) as
                | { id: string; project_id: string }
                | undefined;
              if (!asset)
                throw historyError(
                  "A copied attachment is missing or belongs to another project.",
                );
              repo.put(targetId, "assets", asset.id, {
                assetId: asset.id,
                projectId: asset.project_id,
              });
              for (const linked of [
                ref,
                repo.recordReference(targetId, "assets", asset.id)!,
              ])
                db.prepare(
                  "INSERT OR IGNORE INTO conversation_v3_asset_refs(object_hash,asset_id) VALUES(?,?)",
                ).run(hashBytes(linked), asset.id);
            }
            afterSequence = row.sequence;
            afterRow = row.rowid;
            if (row.id === source.messageId) found = true;
          }
        })();
        if (found) break;
      }
      new VersionCollector(repo.objects).collect({ maxObjects: 64, maxMs: 4 });
      await yieldNow();
    } while (true);
    if (source.stopAtMessage && !found)
      throw historyError("The selected reply disappeared during copying.");
    const result = {
      sessionId: targetId,
      workspaceMode: mode,
      rollbackEnabled: false as const,
    };
    db.transaction(() => {
      store.createSession(target);
      if (source.versionId && !source.stopAtMessage) {
        let summary: Record<string, unknown> | undefined;
        try {
          summary = repo.last(readerId, "compactions");
        } catch (error) {
          if ((error as { code?: string }).code !== "VERSION_RECORD_BUDGET")
            throw error;
        }
        if (summary)
          store.saveCompactionRecord({
            ...summary,
            id: `cmp_${randomUUID()}`,
            sessionId: targetId,
            runId: null,
          } as unknown as CompactionRecord);
      }
      db.prepare(
        "UPDATE conversation_history_operations SET state='committed',result_json=? WHERE id=?",
      ).run(JSON.stringify(result), operationId);
    })();
    published = true;
    await dropHead(readerId);
    emitRuntimeBusEvent({ type: "session_created", sessionId: targetId });
    return result;
  } catch (error) {
    if (job && prepared && !published) {
      try {
        await recoverSimpleFork(operationId, true);
      } catch {
        /* durable recovery_required is shown by the source UI */
      }
    }
    throw error;
  } finally {
    activeHistoryOperations.delete(operationId);
    copying = false;
  }
}
export async function recoverSimpleFork(
  operationId: string,
  internal = false,
): Promise<void> {
  const db = getRawSqlite();
  const row = db
    .prepare(
      "SELECT state,payload_json FROM conversation_history_operations WHERE id=?",
    )
    .get(operationId) as { state: string; payload_json: string } | undefined;
  if (!row || row.state === "aborted") return;
  const job = JSON.parse(row.payload_json) as ForkJob;
  if (!internal) {
    if (activeHistoryOperations.has(operationId))
      throw historyError("Fork is still running.");
    if (job.ownerPid !== process.pid) {
      let alive = true;
      try {
        process.kill(job.ownerPid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive) throw historyError("Fork is owned by another live process.");
    }
  }
  try {
    await dropHead(job.readerId);
    if (row.state !== "committed") {
      if (
        db
          .prepare("SELECT 1 FROM agent_runtime_sessions WHERE id=?")
          .get(job.targetId)
      )
        throw historyError(
          "Target session already exists; refusing to remove published fork data.",
          "HISTORY_RECOVERY_REQUIRED",
        );
      if (job.workspace) await removeForkWorkspace(job.workspace);
      await dropHead(job.targetId);
      db.prepare(
        "UPDATE conversation_history_operations SET state='aborted' WHERE id=?",
      ).run(operationId);
    }
  } catch (error) {
    if (row.state !== "committed")
      db.prepare(
        "UPDATE conversation_history_operations SET state='recovery_required' WHERE id=?",
      ).run(operationId);
    throw error;
  }
}
