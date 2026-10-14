import { getRawSqlite } from "../../infrastructure/database/index.js";
import { versionedSession, versionRepository } from "./checkpoints/version-runtime/bridge.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DATA_ROOT } from "../../infrastructure/runtime/env.js";
import { appendTranscript, appendTranscriptBatch, readTranscript } from "../../infrastructure/storage/transcript-jsonl.js";
import type { AgentRuntimeMessage } from "./contracts.js";
import { TRANSCRIPT_STORAGE } from "../../infrastructure/runtime/env.js";

export interface TranscriptPosition { sequence: number; rowid: number }
export interface TranscriptIdentity { id: string }
export interface TranscriptCopyEntry extends TranscriptPosition { id: string; bytes: number }
export type TranscriptRow = Record<string, string | number | null>;

export const transcriptStorageEnabled = () => TRANSCRIPT_STORAGE === "jsonl";

/** Metadata-only queries. These must never load message/tool bodies just to
 * render checkpoint controls or count history. Raw legacy rows are confined to
 * the legacy adapter while the version repository retains its pinned readers.
 * JSONL is not enabled until mutation/rollback and all readers share a backend. */
export class TranscriptRepository {
  /** Lazy migration is attempted only for an inactive session. A live session
   * keeps reading the legacy source until its next safe boundary. */
  ensureJsonl(sessionId: string): boolean {
    if (!transcriptStorageEnabled() || versionedSession(sessionId)) return false;
    if (this.hasJsonl(sessionId)) return true;
    const db = getRawSqlite();
    if (db.inTransaction) return false;
    try { this.stageLegacyJsonl(sessionId); return true; } catch (error) {
      if (error instanceof AgentRuntimeError && ["TRANSCRIPT_MIGRATION_BUSY", "TRANSCRIPT_MIGRATION_PAGE_REQUIRED"].includes(error.code)) return false;
      throw error;
    }
  }

  /** Validate a bounded legacy copy without switching the live session backend.
   * A later cutover must fence legacy writers and integrate undo/search first. */
  stageLegacyJsonl(sessionId: string): number {
    this.assertJsonlDurability();
    const db = getRawSqlite();
    return db.transaction(() => {
      this.assertLegacy(sessionId);
      const session = db.prepare("SELECT status,active_run_id FROM agent_runtime_sessions WHERE id=?").get(sessionId) as { status: string; active_run_id: string | null } | undefined;
      if (!session || session.active_run_id || !["completed", "failed", "interrupted"].includes(session.status))
        throw new AgentRuntimeError("Migration requires an inactive session.", "TRANSCRIPT_MIGRATION_BUSY", 409);
      if (db.prepare("SELECT 1 FROM transcript_heads WHERE session_id=?").get(sessionId))
        throw new AgentRuntimeError("A transcript copy already exists; validate it before replacing it.", "TRANSCRIPT_MIGRATION_EXISTS", 409);
      const sizes = db.prepare(`SELECT length(CAST(content AS BLOB))+COALESCE(length(CAST(metadata_json AS BLOB)),0)+COALESCE(length(CAST(content_parts_json AS BLOB)),0) AS bytes
        FROM agent_runtime_messages WHERE session_id=? ORDER BY sequence,created_at,rowid LIMIT 257`).all(sessionId) as { bytes: number }[];
      if (sizes.length > 256 || sizes.some(row => row.bytes > 48 * 1024) || sizes.reduce((sum,row) => sum + row.bytes,0) > 512 * 1024)
        throw new AgentRuntimeError("Legacy transcript requires paged migration.", "TRANSCRIPT_MIGRATION_PAGE_REQUIRED", 409);
      if (!sizes.length) return 0;
      const rows = this.legacyMessageRows(sessionId);
      const records = rows.map(row => {
        const payload = Buffer.from(JSON.stringify({ id: row.id, sessionId: row.session_id, runId: row.run_id, stepId: row.step_id,
          role: row.role, content: row.content, metadata: JSON.parse(String(row.metadata_json ?? "{}")), createdAt: row.created_at,
          ...(row.content_parts_json ? {contentParts:JSON.parse(String(row.content_parts_json))} : {}) }));
        return {hash:createHash("sha256").update(payload).digest("hex"),kind:"message",payload,references:[]};
      });
      const segment = randomUUID();
      const locations = appendTranscriptBatch(path.resolve(DATA_ROOT),segment,0,records);
      for (let i=0;i<records.length;i++) {
        const reread=readTranscript(path.resolve(DATA_ROOT),segment,locations[i].offset,locations[i].length);
        if (!reread.payload.equals(records[i].payload)) throw new AgentRuntimeError("Migration verification failed.", "TRANSCRIPT_CORRUPT");
      }
      const tail=locations.at(-1)!;
      db.prepare("INSERT INTO transcript_heads(session_id,segment,committed_bytes,record_count,visible_sequence,revision,updated_at) VALUES(?,?,?,?,?,1,?)")
        .run(sessionId,segment,tail.offset+tail.length,records.length,records.length,new Date().toISOString());
      const insert=db.prepare("INSERT INTO transcript_records(session_id,message_id,sequence,offset,length,payload_bytes,hash,kind,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
      records.forEach((record,i) => insert.run(sessionId,rows[i].id,i+1,locations[i].offset,locations[i].length,record.payload.length,record.hash,"message",rows[i].created_at));
      return records.length;
    })();
  }

  legacyMessageRows(sessionId: string): TranscriptRow[] {
    this.assertLegacy(sessionId);
    return getRawSqlite().prepare("SELECT * FROM agent_runtime_messages WHERE session_id=? ORDER BY sequence,created_at,rowid").all(sessionId) as TranscriptRow[];
  }

  legacyMessageRow(sessionId: string, messageId: string): TranscriptRow | undefined {
    this.assertLegacy(sessionId);
    return getRawSqlite().prepare("SELECT * FROM agent_runtime_messages WHERE id=? AND session_id=?").get(messageId, sessionId) as TranscriptRow | undefined;
  }

  /** Raw row compatibility is required by the legacy undo journal. Keep column
   * filtering here so restoring old checkpoints tolerates newer schemas. */
  legacyRows(sessionId: string): TranscriptRow[] {
    this.assertLegacy(sessionId);
    return getRawSqlite().prepare("SELECT * FROM agent_runtime_messages WHERE session_id=? ORDER BY rowid").all(sessionId) as TranscriptRow[];
  }

  insertLegacyRow(row: TranscriptRow): void {
    this.writeLegacyRow(row, false);
  }

  restoreLegacyRow(row: TranscriptRow): void {
    this.writeLegacyRow(row, true);
  }

  deleteLegacySession(sessionId: string): void {
    this.assertLegacy(sessionId);
    getRawSqlite().prepare("DELETE FROM agent_runtime_messages WHERE session_id=?").run(sessionId);
  }

  deleteLegacyRecord(id: string): void {
    const db = getRawSqlite();
    const row = db.prepare("SELECT session_id FROM agent_runtime_messages WHERE id=?").get(id) as { session_id: string } | undefined;
    if (row) this.assertLegacy(row.session_id);
    db.prepare("DELETE FROM agent_runtime_messages WHERE id=?").run(id);
  }

  private writeLegacyRow(row: TranscriptRow, restore: boolean): void {
    if (typeof row.session_id !== "string") throw new AgentRuntimeError("Missing transcript owner.", "TRANSCRIPT_OWNER_INVALID", 400);
    this.assertLegacy(row.session_id);
    const db = getRawSqlite();
    const columns = new Set((db.prepare("PRAGMA table_info(agent_runtime_messages)").all() as { name: string }[]).map((column) => column.name));
    const keys = Object.keys(row).filter((key) => columns.has(key));
    const updates = keys.filter((key) => key !== "id").map((key) => `"${key}"=excluded."${key}"`).join(",");
    const conflict = restore ? ` ON CONFLICT(id) ${updates ? `DO UPDATE SET ${updates}` : "DO NOTHING"}` : "";
    db.prepare(`INSERT INTO agent_runtime_messages (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})${conflict}`).run(...keys.map((key) => row[key]));
  }

  count(sessionId: string): number {
    if (versionedSession(sessionId)) return versionRepository().count(sessionId, "messages");
    if (this.ensureJsonl(sessionId)) return Number((getRawSqlite().prepare("SELECT count(*) AS count FROM transcript_records WHERE session_id=? AND visible=1").get(sessionId) as { count: number }).count);
    return (getRawSqlite().prepare("SELECT count(*) AS count FROM agent_runtime_messages WHERE session_id=?").get(sessionId) as { count: number }).count;
  }

  appendJsonl(message: AgentRuntimeMessage): AgentRuntimeMessage {
    const db = getRawSqlite();
    this.assertJsonlDurability();
    return db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM agent_runtime_sessions WHERE id=?").get(message.sessionId))
        throw new AgentRuntimeError("Transcript session does not exist.", "TRANSCRIPT_OWNER_INVALID", 404);
      const existing = db.prepare("SELECT visible,hash FROM transcript_records WHERE session_id=? AND message_id=?").get(message.sessionId, message.id) as { visible: number; hash: string } | undefined;
      if (existing) {
        const stored = this.jsonlMessage(message.sessionId, message.id);
        if (!existing.visible || !stored || JSON.stringify(stored) !== JSON.stringify(message))
          throw new AgentRuntimeError("Message identity already belongs to another transcript record.", "TRANSCRIPT_ID_CONFLICT", 409);
        return stored;
      }
      let head = db.prepare("SELECT * FROM transcript_heads WHERE session_id=?").get(message.sessionId) as { segment: string; committed_bytes: number; record_count: number; visible_sequence: number } | undefined;
      if (!head) {
        head = { segment: randomUUID(), committed_bytes: 0, record_count: 0, visible_sequence: 0 };
        db.prepare("INSERT INTO transcript_heads(session_id,segment,updated_at) VALUES(?,?,?)").run(message.sessionId, head.segment, new Date().toISOString());
      }
      const sequence = head.record_count + 1;
      const payload = Buffer.from(JSON.stringify(message), "utf8");
      const hash = createHash("sha256").update(payload).digest("hex");
      const location = appendTranscript(path.resolve(DATA_ROOT), head.segment, head.committed_bytes, { hash, kind: "message", payload, references: [] });
      db.prepare("INSERT INTO transcript_records(session_id,message_id,sequence,offset,length,payload_bytes,hash,kind,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(message.sessionId, message.id, sequence, location.offset, location.length, location.payloadBytes, hash, "message", message.createdAt);
      db.prepare("UPDATE transcript_heads SET committed_bytes=?,record_count=?,visible_sequence=?,revision=revision+1,updated_at=? WHERE session_id=?").run(head.committed_bytes + location.length, head.record_count + 1, sequence, new Date().toISOString(), message.sessionId);
      return message;
    })();
  }

  jsonlMessages(sessionId: string): AgentRuntimeMessage[] {
    return getRawSqlite().transaction(() => this.readJsonlMessages(sessionId))();
  }

  private readJsonlMessages(sessionId: string): AgentRuntimeMessage[] {
    const db = getRawSqlite();
    const head = db.prepare("SELECT segment,visible_sequence,committed_bytes FROM transcript_heads WHERE session_id=?").get(sessionId) as { segment: string; visible_sequence: number; committed_bytes: number } | undefined;
    if (!head) return [];
    const rows = db.prepare("SELECT message_id,offset,length,hash FROM transcript_records WHERE session_id=? AND visible=1 AND sequence<=? ORDER BY sequence").all(sessionId, head.visible_sequence) as Array<{ message_id: string; offset: number; length: number; hash: string }>;
    return rows.map((row) => {
      if (row.offset + row.length > head.committed_bytes) throw new AgentRuntimeError("Transcript pointer exceeds committed bytes.", "TRANSCRIPT_INDEX_CORRUPT");
      const record = readTranscript(path.resolve(DATA_ROOT), head.segment, row.offset, row.length);
      if (record.hash !== row.hash || record.kind !== "message" || record.hash !== createHash("sha256").update(record.payload).digest("hex")) throw new AgentRuntimeError("Transcript integrity check failed.", "TRANSCRIPT_CORRUPT");
      const message = JSON.parse(record.payload.toString("utf8")) as AgentRuntimeMessage;
      if (message.id !== row.message_id || message.sessionId !== sessionId) throw new AgentRuntimeError("Transcript index does not match payload.", "TRANSCRIPT_INDEX_CORRUPT");
      return message;
    });
  }

  jsonlMessage(sessionId: string, messageId: string): AgentRuntimeMessage | undefined {
    return this.jsonlMessages(sessionId).find((message) => message.id === messageId);
  }

  setJsonlVisibleThrough(sessionId: string, sequence: number, expectedRevision: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new AgentRuntimeError("Invalid transcript visibility boundary.", "TRANSCRIPT_BOUNDARY_INVALID", 400);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new AgentRuntimeError("Invalid transcript revision.", "TRANSCRIPT_REVISION_STALE", 400);
    const db = getRawSqlite();
    this.assertJsonlDurability();
    db.transaction(() => {
      const head = db.prepare("SELECT revision,visible_sequence FROM transcript_heads WHERE session_id=?").get(sessionId) as { revision: number; visible_sequence: number } | undefined;
      if (!head || head.revision !== expectedRevision) throw new AgentRuntimeError("Stale transcript revision.", "TRANSCRIPT_REVISION_STALE", 409);
      if (sequence > head.visible_sequence || (sequence !== 0 && !db.prepare("SELECT 1 FROM transcript_records WHERE session_id=? AND sequence=? AND visible=1").get(sessionId, sequence)))
        throw new AgentRuntimeError("Boundary is not visible in this branch.", "TRANSCRIPT_BOUNDARY_INVALID", 409);
      db.prepare("UPDATE transcript_records SET visible=0 WHERE sequence>? AND session_id=?").run(sequence, sessionId);
      db.prepare("UPDATE transcript_heads SET visible_sequence=?,revision=revision+1,updated_at=? WHERE session_id=?").run(sequence, new Date().toISOString(), sessionId);
    })();
  }

  private assertJsonlDurability(): void {
    // JSONL append can be nested in an existing runtime savepoint. The storage
    // owner still serializes the SQLite control update; the file fsync happens
    // before that savepoint is released. Rejecting nesting here caused a
    // completed model response to be persisted and then reported as failed.
    const db = getRawSqlite();
    if (db.inTransaction && !process.env.SYNAX_STORAGE_OWNER_ENDPOINT)
      throw new AgentRuntimeError("JSONL acknowledgement requires its own transaction.", "TRANSCRIPT_NESTED_TRANSACTION", 409);
    if ((db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous < 2)
      throw new AgentRuntimeError("JSONL control requires FULL synchronous SQLite.", "TRANSCRIPT_DURABILITY_REQUIRED", 409);
  }

  private hasJsonl(sessionId: string): boolean {
    return Boolean(getRawSqlite().prepare("SELECT 1 FROM transcript_heads WHERE session_id=?").get(sessionId));
  }

  legacyIdentities(sessionId: string): TranscriptIdentity[] {
    this.assertLegacy(sessionId);
    return getRawSqlite().prepare("SELECT id FROM agent_runtime_messages WHERE session_id=? ORDER BY sequence,created_at,rowid").all(sessionId) as TranscriptIdentity[];
  }

  legacyReplyPosition(sessionId: string, id: string): TranscriptPosition | undefined {
    this.assertLegacy(sessionId);
    return getRawSqlite().prepare("SELECT sequence,rowid AS rowid FROM agent_runtime_messages WHERE session_id=? AND id=? AND role='assistant'").get(sessionId, id) as TranscriptPosition | undefined;
  }

  legacyCopyPage(sessionId: string, after: TranscriptPosition, through: TranscriptPosition): TranscriptCopyEntry[] {
    this.assertLegacy(sessionId);
    for (const position of [after, through]) {
      if (!Number.isSafeInteger(position.sequence) || !Number.isSafeInteger(position.rowid))
        throw new AgentRuntimeError("Invalid transcript position.", "TRANSCRIPT_CURSOR_INVALID", 400);
    }
    return getRawSqlite().prepare(`SELECT rowid AS rowid,sequence,id,
      length(CAST(content AS BLOB))+COALESCE(length(CAST(metadata_json AS BLOB)),0)+COALESCE(length(CAST(content_parts_json AS BLOB)),0) AS bytes
      FROM agent_runtime_messages WHERE session_id=? AND (sequence>? OR (sequence=? AND rowid>?))
      AND (sequence<? OR (sequence=? AND rowid<=?)) ORDER BY sequence,rowid LIMIT 16`)
      .all(sessionId, after.sequence, after.sequence, after.rowid, through.sequence, through.sequence, through.rowid) as TranscriptCopyEntry[];
  }

  legacyCopyRow(sessionId: string, position: TranscriptPosition): Record<string, unknown> {
    this.assertLegacy(sessionId);
    const db = getRawSqlite();
    // The caller owns the copy transaction; recheck admission before reading a
    // body, even if metadata was obtained in a previous transaction/page.
    const row = db.prepare(`SELECT length(CAST(content AS BLOB))+COALESCE(length(CAST(metadata_json AS BLOB)),0)+COALESCE(length(CAST(content_parts_json AS BLOB)),0) AS bytes
      FROM agent_runtime_messages WHERE session_id=? AND rowid=? AND sequence=?`)
      .get(sessionId, position.rowid, position.sequence) as { bytes: number } | undefined;
    if (!row) throw new AgentRuntimeError("Transcript changed during copy.", "TRANSCRIPT_CURSOR_STALE", 409);
    if (row.bytes > 768 * 1024) throw new AgentRuntimeError("Legacy message exceeds the bounded copy budget.", "HISTORY_PAGE_REQUIRED", 409);
    return db.prepare("SELECT id,session_id,run_id,step_id,role,content,content_parts_json,metadata_json,created_at FROM agent_runtime_messages WHERE session_id=? AND rowid=? AND sequence=?")
      .get(sessionId, position.rowid, position.sequence) as Record<string, unknown>;
  }

  latestLegacyReply(sessionId: string, stepId?: string | null): { id: string; stepId: string | null } | undefined {
    this.assertLegacy(sessionId);
    return getRawSqlite().prepare(`SELECT id,step_id AS stepId FROM agent_runtime_messages WHERE session_id=? AND role='assistant'
      AND (trim(content)<>'' OR content_parts_json IS NOT NULL)
      AND COALESCE(json_extract(metadata_json,'$.type'),'')<>'thinking'
      AND COALESCE(json_extract(metadata_json,'$.kind'),'')<>'thought'
      AND COALESCE(json_extract(metadata_json,'$.partial'),0)=0 ${stepId ? "AND step_id=?" : ""}
      ORDER BY sequence DESC,created_at DESC LIMIT 1`)
      .get(...(stepId ? [sessionId, stepId] : [sessionId])) as { id: string; stepId: string | null } | undefined;
  }

  private assertLegacy(sessionId: string): void {
    if (versionedSession(sessionId)) throw new AgentRuntimeError("Use the pinned version reader for versioned history.", "TRANSCRIPT_BACKEND_MISMATCH", 409);
  }
}
export const transcriptRepository = new TranscriptRepository();
