import { randomUUID } from "node:crypto";
import { sessionLogClient } from "../../infrastructure/storage/log-client.js";
import { historyEpoch } from "./checkpoints/guards.js";
const FILE_REPLAY_BASE = 2 ** 40;
const replayProducer = randomUUID();
let replayRequestNumber = 0;
import { projectReplayChunk } from "./runtime-stream-projection.js";
import { assertBatchInput } from "./checkpoints/version-runtime/batch-input.js";
import { admitVersionGrowth } from "./checkpoints/resource-admission.js";
import { versionedSession } from "./checkpoints/version-runtime/bridge.js";
import {
  normalizeAgentSessionStatus,
  projectSessionState,
} from "./session-projection.js";
import { getRawSqlite } from "../../infrastructure/database/index.js";
import type { AgentRunStreamChunk, AgentSession } from "./contracts.js";
import { agentRuntimeStore } from "./session-store.js";
import { AgentValidationError } from "./runtime-errors.js";
import { nowIso } from "./runtime-ids.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";

export interface RuntimeStreamRecord {
  sequence: number;
  sessionId: string;
  runId: string;
  chunk: AgentRunStreamChunk;
  state: Pick<
    AgentSession,
    | "status"
    | "activeRunId"
    | "pendingResumeToken"
    | "blockedReason"
    | "updatedAt"
  >;
}
interface JournalRow {
  sequence: number;
  session_id: string;
  run_id: string;
  chunk_json: string;
}
const mapRow = (row: JournalRow): RuntimeStreamRecord => {
  const payload = JSON.parse(row.chunk_json) as {
    chunk: AgentRunStreamChunk;
    state: RuntimeStreamRecord["state"] & { status: unknown };
  };
  return {
    sequence: row.sequence,
    sessionId: row.session_id,
    runId: row.run_id,
    ...payload,
    state: {
      ...payload.state,
      status: normalizeAgentSessionStatus(payload.state.status),
    },
  };
};

function authoritativeState(sessionId: string): RuntimeStreamRecord["state"] {
  const session = projectSessionState(agentRuntimeStore.getSession(sessionId));
  return {
    status: session.status,
    activeRunId: session.activeRunId,
    pendingResumeToken: session.pendingResumeToken,
    blockedReason: session.blockedReason,
    updatedAt: session.updatedAt,
  };
}

async function readAuthoritative(
  sessionId: string,
  after: number,
  limit: number,
  runId?: string,
): Promise<RuntimeStreamRecord[]> {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256)
    throw new AgentValidationError("Invalid stream cursor.");
  const events = await runtimeFacade.replayAuthoritative(sessionId, after, runId);
  const state = authoritativeState(sessionId);
  const records: RuntimeStreamRecord[] = [];
  for (const event of events.slice(0, limit)) {
    let chunk: AgentRunStreamChunk;
    try {
      chunk = JSON.parse(Buffer.from(event.payload).toString("utf8")) as AgentRunStreamChunk;
    } catch (error) {
      throw new AgentValidationError(`Invalid sidecar stream payload: ${error instanceof Error ? error.message : String(error)}`);
    }
    records.push({ sequence: event.sequence, sessionId, runId: event.runId, chunk, state });
  }
  return records;
}

class RuntimeJournal {
  private readonly waiters = new Map<string, Set<() => void>>();

  append(
    sessionId: string,
    runId: string,
    chunk: AgentRunStreamChunk,
  ): RuntimeStreamRecord {
    return this.appendBatch(sessionId, runId, [chunk])[0];
  }

  /**
   * Commits a burst as one atomic transaction. Contract: all records in the
   * batch share a single projected session-state snapshot taken at commit time;
   * caller order is preserved by autoincrement sequence; the batch either lands
   * whole or not at all; and waiters wake only after COMMIT. This is a
   * stronger, coarser guarantee than sequential `append` calls, each of which
   * snapshots state independently and can observe a write that landed between
   * them — the writer relies on a synchronous burst so no such write can occur
   * inside one batch.
   */
  appendBatch(
    sessionId: string,
    runId: string,
    chunks: AgentRunStreamChunk[],
  ): RuntimeStreamRecord[] {
    if (chunks.length === 0) return [];
    if (chunks.length > 256) throw new AgentValidationError("Replay burst limit exceeded.");
    chunks = chunks.map(projectReplayChunk);
    assertBatchInput(chunks);
    const records = getRawSqlite().transaction(() => {
      const run = agentRuntimeStore.getRun(runId);
      if (run.sessionId !== sessionId)
        throw new AgentValidationError(
          "Stream Run belongs to another session.",
        );
      const session = projectSessionState(
        agentRuntimeStore.getSession(sessionId),
      );
      const state: RuntimeStreamRecord["state"] = {
        status: session.status,
        activeRunId: session.activeRunId,
        pendingResumeToken: session.pendingResumeToken,
        blockedReason: session.blockedReason,
        updatedAt: session.updatedAt,
      };
      const insert = getRawSqlite()
        .prepare(`INSERT INTO agent_runtime_stream_records
        (session_id, run_id, kind, chunk_json, created_at,version_epoch) VALUES (?, ?, ?, ?, ?, (SELECT epoch FROM conversation_v3_heads WHERE session_id=?)) RETURNING sequence`);
      const records = chunks.map((chunk) => {
        const encoded = JSON.stringify({ chunk, state });
        if (Buffer.byteLength(encoded) > 64 * 1024) throw new AgentValidationError("Replay record exceeds its byte budget.");
        admitVersionGrowth(getRawSqlite(), Buffer.byteLength(encoded));
        const [row] = insert.all(
          sessionId,
          runId,
          chunk.type,
          encoded,
          nowIso(),
          sessionId,
        ) as Array<{ sequence: number }>;
        return { sequence: row.sequence, sessionId, runId, chunk, state };
      });
      // A bounded diagnostic ring, independent of checkpoints and billing.
      const db = getRawSqlite();
      const cutoff = db.prepare("SELECT sequence FROM agent_runtime_stream_records WHERE session_id=? ORDER BY sequence DESC LIMIT 1 OFFSET 1024").get(sessionId) as { sequence: number } | undefined;
      if (cutoff) db.prepare("DELETE FROM agent_runtime_stream_records WHERE sequence IN (SELECT sequence FROM agent_runtime_stream_records WHERE session_id=? AND sequence<=? ORDER BY sequence LIMIT 256)").run(sessionId, cutoff.sequence);
      return records;
    })();
    this.notifyCommitted(sessionId);
    return records;
  }

  /** File-backed replay is independent of SQLite commit/retention. Existing
   * cursors remain readable below FILE_REPLAY_BASE during the cutover. */
  async appendDurable(sessionId: string, runId: string, chunks: AgentRunStreamChunk[], revision = historyEpoch(sessionId), requestId = `replay:${replayProducer}:${++replayRequestNumber}`): Promise<void> {
    if (!process.env.SYNAX_STORAGE_OWNER_ENDPOINT) { this.appendBatch(sessionId, runId, chunks); return; }
    if (!chunks.length) return;
    chunks = chunks.map(projectReplayChunk);
    assertBatchInput(chunks);
    const state = getRawSqlite().readTransaction(() => {
      if (historyEpoch(sessionId) !== revision) throw new AgentValidationError("Obsolete conversation execution.");
      const run = agentRuntimeStore.getRun(runId);
      if (run.sessionId !== sessionId) throw new AgentValidationError("Stream Run belongs to another session.");
      const session = projectSessionState(agentRuntimeStore.getSession(sessionId));
      return { status: session.status, activeRunId: session.activeRunId, pendingResumeToken: session.pendingResumeToken, blockedReason: session.blockedReason, updatedAt: session.updatedAt };
    })();
    await sessionLogClient.append(sessionId, requestId, chunks.map(chunk => ({ type: "runtime.replay", payload: { sessionId, runId, chunk, state, epoch: revision } })));
    this.notifyCommitted(sessionId);
  }

  async readDurable(sessionId: string, after = 0, limit = 256, runId?: string): Promise<RuntimeStreamRecord[]> {
    if (runtimeFacade.streamMode() === 'authoritative')
      return readAuthoritative(sessionId, after, limit, runId);
    if (!process.env.SYNAX_STORAGE_OWNER_ENDPOINT) return this.read(sessionId, after, limit, runId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new AgentValidationError("Invalid stream cursor.");
    const legacy = after < FILE_REPLAY_BASE ? this.read(sessionId, after, limit, runId) : [];
    if (legacy.length) return legacy;
    const epoch = historyEpoch(sessionId);
    let position = Math.max(0, after - FILE_REPLAY_BASE);
    for (;;) {
      const events = await sessionLogClient.read(sessionId, position, limit);
      if (!events.length) return [];
      const records: RuntimeStreamRecord[] = [];
      for (const event of events) {
        position = event.sequence;
        if (event.type !== "runtime.replay") continue;
        const value = event.payload as RuntimeStreamRecord & { epoch: number };
        if (value.epoch !== epoch || (runId && value.runId !== runId)) continue;
        records.push({ sessionId, runId: value.runId, chunk: value.chunk, state: value.state, sequence: FILE_REPLAY_BASE + event.sequence });
      }
      if (records.length) return records;
    }
  }

  async snapshotDurable(sessionId: string): Promise<ReturnType<RuntimeJournal["snapshot"]>> {
    if (runtimeFacade.streamMode() === 'authoritative') {
      const snapshot = this.snapshot(sessionId);
      const remote = await runtimeFacade.snapshotAuthoritative(sessionId);
      if (!remote) return snapshot;
      snapshot.cursor = remote.cursor;
      const current = snapshot.run ? agentRuntimeStore.listRunSteps(snapshot.run.id).at(-1) : undefined;
      if (current && !current.completedAt) {
        const replay = await readAuthoritative(sessionId, Math.max(0, remote.cursor - 1024), 256, snapshot.run!.id);
        snapshot.liveChunks = [{ type: "step_started", step: current }];
        for (const record of replay) {
          const chunk = record.chunk;
          if (!("stepId" in chunk) || chunk.stepId !== current.id) continue;
          if (chunk.type === "retry_status" && ["waiting", "group_wait"].includes(chunk.retry.phase)) snapshot.liveChunks.length = 1;
          snapshot.liveChunks.push(chunk);
        }
      }
      return snapshot;
    }
    if (!process.env.SYNAX_STORAGE_OWNER_ENDPOINT) return this.snapshot(sessionId);
    // Capture a cursor before the SQL snapshot: new events after it are replayed
    // by observe(), including events committed during snapshot assembly.
    const fileCursor = await sessionLogClient.cursor(sessionId);
    const snapshot = this.snapshot(sessionId);
    if (!fileCursor) return snapshot;
    snapshot.cursor = FILE_REPLAY_BASE + fileCursor;
    const current = snapshot.run ? agentRuntimeStore.listRunSteps(snapshot.run.id).at(-1) : undefined;
    if (current && !current.completedAt) {
      const replay: RuntimeStreamRecord[] = [];
      let after = FILE_REPLAY_BASE + Math.max(0, fileCursor - 1024);
      while (after < snapshot.cursor) {
        const page = await this.readDurable(sessionId, after, 256, snapshot.run!.id);
        if (!page.length) break;
        after = page[page.length - 1].sequence;
        replay.push(...page.filter(row => row.sequence <= snapshot.cursor));
      }
      snapshot.liveChunks = [{ type: "step_started", step: current }];
      for (const record of replay) {
        const chunk = record.chunk;
        if (!("stepId" in chunk) || chunk.stepId !== current.id) continue;
        if (chunk.type === "retry_status" && ["waiting", "group_wait"].includes(chunk.retry.phase)) snapshot.liveChunks.length = 1;
        snapshot.liveChunks.push(chunk);
      }
    }
    return snapshot;
  }

  /** Called only after the local or remote writer has committed. */
  notifyCommitted(sessionId: string): void {
    for (const wake of [...(this.waiters.get(sessionId) ?? [])]) wake();
  }

  cursor(sessionId: string): number {
    if (versionedSession(sessionId))
      return (
        (
          getRawSqlite()
            .prepare(
              "SELECT MAX(sequence) AS value FROM agent_runtime_stream_records WHERE session_id=? AND version_epoch=(SELECT epoch FROM conversation_v3_heads WHERE session_id=?)",
            )
            .get(sessionId, sessionId) as { value: number | null }
        ).value ?? 0
      );
    const row = getRawSqlite()
      .prepare(
        "SELECT MAX(sequence) AS value FROM agent_runtime_stream_records WHERE session_id = ?",
      )
      .get(sessionId) as { value: number | null };
    return row.value ?? 0;
  }

  read(
    sessionId: string,
    after = 0,
    limit = 256,
    runId?: string,
  ): RuntimeStreamRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 || !Number.isSafeInteger(after) || after < 0)
      throw new AgentValidationError("Invalid stream cursor.");
    const versioned = versionedSession(sessionId);
    const rows = getRawSqlite()
      .prepare(
        `SELECT sequence, length(CAST(chunk_json AS BLOB)) AS bytes FROM agent_runtime_stream_records
      WHERE session_id = ? AND sequence > ? ${versioned ? "AND version_epoch=(SELECT epoch FROM conversation_v3_heads WHERE session_id=?)" : ""} ${runId ? "AND run_id = ?" : ""} ORDER BY sequence LIMIT ?`,
      )
      .all(
        sessionId,
        after,
        ...(versioned ? [sessionId] : []),
        ...(runId ? [runId] : []),
        limit,
      ) as { sequence: number; bytes: number }[];
    const result: RuntimeStreamRecord[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (row.bytes > 1024 * 1024) throw new AgentValidationError("Stored replay record exceeds its read budget.");
      if (bytes + row.bytes > 1024 * 1024) break;
      bytes += row.bytes;
      const full = getRawSqlite().prepare("SELECT sequence,session_id,run_id,chunk_json FROM agent_runtime_stream_records WHERE sequence=?").get(row.sequence) as JournalRow;
      result.push(mapRow(full));
    }
    return result;
  }

  async *observe(
    sessionId: string,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeStreamRecord> {
    let cursor = after;
    while (!signal?.aborted) {
      const records = await this.readDurable(sessionId, cursor);
      for (const record of records) {
        if (signal?.aborted) return;
        cursor = record.sequence;
        yield record;
      }
      if (records.length === 0) await this.wait(sessionId, signal);
    }
  }

  wait(sessionId: string, signal?: AbortSignal, ms = 150): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.waiters.get(sessionId) ?? new Set<() => void>();
      // The timeout is created after wake closes over it.
      // eslint-disable-next-line prefer-const
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", wake);
        waiters.delete(wake);
        if (waiters.size === 0) this.waiters.delete(sessionId);
        resolve();
      };
      waiters.add(wake);
      this.waiters.set(sessionId, waiters);
      timer = setTimeout(wake, ms);
      signal?.addEventListener("abort", wake, { once: true });
    });
  }

  snapshot(sessionId: string) {
    return getRawSqlite().readTransaction(() => {
      const session = projectSessionState(
        agentRuntimeStore.getSession(sessionId),
      );
      const run = session.activeRunId
        ? agentRuntimeStore.getRun(session.activeRunId)
        : (agentRuntimeStore.listRuns(sessionId)[0] ?? null);
      const cursor = this.cursor(sessionId);
      const steps = run ? agentRuntimeStore.listRunSteps(run.id) : [];
      const current = steps.at(-1);
      const liveChunks: AgentRunStreamChunk[] = [];
      if (
        run &&
        current &&
        !current.completedAt &&
        ["running", "waiting_permission", "waiting_input"].includes(run.status)
      ) {
        const start = getRawSqlite()
          .prepare(
            `SELECT sequence FROM agent_runtime_stream_records WHERE run_id = ?
          AND kind = 'step_started' AND json_extract(chunk_json, '$.chunk.step.id') = ? ORDER BY sequence DESC LIMIT 1`,
          )
          .get(run.id, current.id) as { sequence: number } | undefined;
        liveChunks.push({ type: "step_started", step: current });
        if (start) {
          const rows = getRawSqlite()
            .prepare(
              `SELECT sequence, session_id, run_id, chunk_json FROM agent_runtime_stream_records
            WHERE run_id = ? AND sequence > ? AND sequence <= ? AND length(CAST(chunk_json AS BLOB))<=65536 ORDER BY sequence DESC LIMIT 128`,
            )
            .all(run.id, start.sequence, cursor) as JournalRow[];
          for (const row of rows.reverse()) {
            const chunk = mapRow(row).chunk;
            if ("stepId" in chunk && chunk.stepId === current.id) {
              if (
                chunk.type === "retry_status" &&
                ["waiting", "group_wait"].includes(chunk.retry.phase)
              )
                liveChunks.length = 1;
              liveChunks.push(chunk);
            }
          }
        }
      }
      return {
        session,
        run,
        cursor,
        liveChunks,
        completedStepIds: steps
          .filter((step) => Boolean(step.completedAt))
          .map((step) => step.id),
      };
    })();
  }
}

export const runtimeJournal = new RuntimeJournal();
