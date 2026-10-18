/** Offline 1.x reader. Deliberately independent of the retired online runtime. */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import Database from 'libsql';
import { exportTables, nativeRow, type Row } from './records.js';

const versionTables: Record<string, string> = {
  agent_runtime_messages: 'messages', agent_runtime_events: 'events',
  agent_runtime_runs: 'runs', agent_runtime_run_steps: 'steps',
  agent_runtime_run_parts: 'parts', agent_runtime_tool_calls: 'tools',
  agent_runtime_permissions: 'permissions', agent_runtime_artifacts: 'artifacts',
  agent_runtime_context_bundles: 'contexts', agent_runtime_thinking_summaries: 'thinking',
  agent_runtime_compaction_summaries: 'compactions', agent_runtime_interactions: 'interactions',
  agent_runtime_work: 'work',
};
const immutableBoundaryTables = new Set(['messages', 'contexts', 'compactions', 'work']);
const liveMetadata = ['permissionTier', 'permissionOverrides', 'runtimeControl', 'manualStop',
  'inputQueue', 'inputForceInjectId', 'pendingResume', 'turnReferences', 'historyRevision', 'latestSystemPrompt'];
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const objectId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid V1 object identity');
  return value;
};
const hex = (value: unknown): string | null => value == null ? null : Buffer.from(value as Uint8Array).toString('hex');

interface StoredObject { kind: string; bytes: Buffer; refs: string[] }
interface Roots { stateRoot: string | null; aggregateRoot: string | null }
interface Head extends Row { version_id: Uint8Array; epoch: number; boundary_only: number; full_history: number; legacy_runtime: number; rollback_enabled?: number }
interface Tree { height: number; count: number; entries: Array<[string, string, number?]> }
export interface V1Session { id: string; session: Row; mode: 'versioned' | 'flat' | 'transcript' | 'sql'; head?: Head; roots?: Roots }
export interface V1Record { table: string; source: 'versioned' | 'transcript' | 'sql'; value: Row }

export class V1Reader {
  readonly db: Database.Database;
  private readonly tables: Set<string>;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly cache = new Map<string, StoredObject>();
  private cacheBytes = 0;

  constructor(readonly root: string, database = path.join(root, 'context.db')) {
    this.db = new Database(database, { readonly: true });
    this.db.exec('BEGIN');
    this.tables = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    if (!this.tables.has('agent_runtime_sessions')) { this.close(); throw new Error('V1 session table is missing'); }
  }

  close(): void { this.db.exec('ROLLBACK'); this.db.close(); this.cache.clear(); }
  private query(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private get(table: string, column: string, id: string): Row | undefined {
    return this.tables.has(table) ? this.query(`SELECT * FROM ${table} WHERE ${column}=?`).get(id) as Row | undefined : undefined;
  }

  *sessions(): Generator<V1Session> {
    for (const raw of this.query('SELECT * FROM agent_runtime_sessions ORDER BY id').iterate() as Iterable<Row>) {
      const session = nativeRow('agent_runtime_sessions', raw), id = String(session.id);
      const head = this.get('conversation_v3_heads', 'session_id', id) as Head | undefined;
      if (head) {
        const roots = this.version(hex(head.version_id)!);
        const reference = this.treeGet(roots.stateRoot, 'session');
        if (!reference) throw new Error(`V1 session ${id} has no immutable session record`);
        const history = this.record(reference, 'session').value;
        if (history.id !== id) throw new Error(`V1 immutable session identity differs from ${id}`);
        const metadata = { ...history.sessionMetadata as Row };
        for (const field of liveMetadata) {
          const value = (session.sessionMetadata as Row | undefined)?.[field];
          if (value !== undefined) metadata[field] = value;
        }
        for (const field of ['prompt', 'resultSummary', 'contextSnapshotId']) session[field] = history[field];
        session.sessionMetadata = metadata;
        yield { id, session, mode: 'versioned', head, roots };
      } else {
        const mode = this.get('conversation_flat_heads', 'session_id', id) ? 'flat'
          : this.get('transcript_heads', 'session_id', id) ? 'transcript' : 'sql';
        yield { id, session, mode };
      }
    }
  }

  *records(session: V1Session): Generator<V1Record> {
    for (const table of exportTables) {
      const kind = versionTables[table];
      if (session.head && kind) {
        const diagnostic = kind !== 'messages' && session.head.boundary_only
          && (!immutableBoundaryTables.has(kind) || session.head.rollback_enabled === 0);
        if (!diagnostic) {
          for (const value of this.versionRecords(session.roots!, kind)) {
            yield { table, source: 'versioned', value: this.entityValue(session, table, kind, value, Number(value.__synaxExecutionEpoch)) };
          }
        } else {
          for (const value of this.diagnostics(session, table, kind)) yield { table, source: 'sql', value };
        }
      } else if (session.mode === 'transcript' && table === 'agent_runtime_messages') {
        for (const value of this.transcript(session.id)) yield { table, source: 'transcript', value: nativeRow(table, value) };
      } else if (this.tables.has(table)) {
        // Flat rollback physically removes the suffix; remaining SQL rows are visible.
        for (const row of this.query(`SELECT * FROM ${table} WHERE session_id=? ORDER BY rowid`).iterate(session.id) as Iterable<Row>) {
          yield { table, source: 'sql', value: nativeRow(table, row) };
        }
      }
    }
  }

  *checkpoints(session: V1Session): Generator<Row> {
    if (!session.head) return;
    for (const [, reference] of this.treeEntries(hex(session.head.checkpoint_root))) {
      const checkpoint = this.json(reference, 'record') as Row;
      // Validate the retained version even when it is no longer the current head.
      this.version(String((checkpoint.payload as Row).versionId));
      yield checkpoint;
    }
  }

  *assets(): Generator<Row> {
    if (!this.tables.has('agent_runtime_assets')) return;
    for (const row of this.query('SELECT * FROM agent_runtime_assets ORDER BY id').iterate() as Iterable<Row>) yield nativeRow('agent_runtime_assets', row);
  }
  *assetBindings(): Generator<Row> {
    if (!this.tables.has('agent_runtime_asset_sessions')) return;
    for (const row of this.query('SELECT * FROM agent_runtime_asset_sessions ORDER BY asset_id,session_id').iterate() as Iterable<Row>) yield nativeRow('agent_runtime_asset_sessions', row);
  }

  /** Retained history, including checkpoint/file roots outside the visible head.
   * These are archive input for the native importer, never online fallback data. */
  *retainedObjects(): Generator<{ id: string; kind: string; bytesBase64: string; refs: string[] }> {
    if (!this.tables.has('conversation_v3_heads')) return;
    const pending: string[] = [];
    for (const head of this.query('SELECT * FROM conversation_v3_heads ORDER BY session_id').iterate() as Iterable<Row>) {
      for (const key of ['version_id', 'checkpoint_root', 'checkpoint_identity_root']) {
        const ref = hex(head[key]); if (ref) pending.push(ref);
      }
    }
    if (this.tables.has('conversation_v3_pins')) {
      for (const pin of this.query('SELECT object_id FROM conversation_v3_pins ORDER BY id').iterate() as Iterable<Row>) pending.push(hex(pin.object_id)!);
    }
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const stored = this.object(id);
      pending.push(...stored.refs);
      yield { id, kind: stored.kind, bytesBase64: stored.bytes.toString('base64'), refs: stored.refs };
    }
  }

  *assetChunks(asset: Row): Generator<Buffer> {
    const id = String(asset.id);
    if (path.basename(id) !== id) throw new Error('Invalid V1 asset identity');
    const fd = openSync(path.join(this.root, 'runtime-media', id), 'r');
    const digest = createHash('sha256');
    let size = 0;
    try {
      const buffer = Buffer.alloc(256 * 1024);
      for (;;) {
        const length = readSync(fd, buffer, 0, buffer.length, null);
        if (!length) break;
        const chunk = Buffer.from(buffer.subarray(0, length));
        size += length; digest.update(chunk); yield chunk;
      }
      if (size !== asset.size || digest.digest('hex') !== asset.sha256) throw new Error(`V1 asset checksum mismatch: ${id}`);
    } finally { closeSync(fd); }
  }

  private *diagnostics(session: V1Session, table: string, kind: string): Generator<Row> {
    if (!this.tables.has(table)) return;
    const head = session.head!;
    const epochs = new Map<number, number>();
    for (const [key, ref] of this.treeEntries(session.roots!.aggregateRoot)) epochs.set(Number(key), Number(this.json(ref, 'record').through));
    epochs.set(head.epoch, Number.MAX_SAFE_INTEGER);
    if (this.tables.has('conversation_v3_runtime_records')) {
      const query = this.query(`SELECT t.* FROM conversation_v3_runtime_records r JOIN ${table} t ON t.session_id=r.session_id AND t.id=r.record_id
        WHERE r.session_id=? AND r.kind=? AND r.epoch=? AND r.sequence<=? ORDER BY r.sequence`);
      if (head.legacy_runtime) {
        for (const row of this.query(`SELECT t.* FROM ${table} t WHERE t.session_id=? AND NOT EXISTS
          (SELECT 1 FROM conversation_v3_runtime_records r WHERE r.session_id=t.session_id AND r.kind=? AND r.record_id=t.id) ORDER BY t.rowid`).iterate(session.id, kind) as Iterable<Row>) yield this.entityValue(session, table, kind, row, 0);
      }
      for (const [epoch, through] of [...epochs].sort(([a], [b]) => a - b)) {
        for (const row of query.iterate(session.id, kind, epoch, through) as Iterable<Row>) yield this.entityValue(session, table, kind, row, epoch);
      }
    } else if (head.legacy_runtime) {
      for (const row of this.query(`SELECT * FROM ${table} WHERE session_id=? ORDER BY rowid`).iterate(session.id) as Iterable<Row>) yield this.entityValue(session, table, kind, row, 0);
    }
  }

  private entityValue(session: V1Session, table: string, kind: string, row: Row, epoch: number): Row {
    const value = nativeRow(table, row);
    if (epoch === session.head!.epoch) {
      const controls: Record<string, string[]> = {
        interactions: ['status', 'resolvedAt'], runs: ['status', 'completedAt', 'stopReason', 'currentStep'],
        steps: ['status', 'completedAt', 'finishReason'], tools: ['status', 'endedAt', 'error'],
        permissions: ['action', 'userReply', 'resolvedAt', 'resumeToken'],
      };
      // Immutable records carry content; matching-epoch SQL retains live control fields.
      if (controls[kind] && row.session_id === undefined) {
        const current = this.get(table, 'id', String(value.id));
        if (current?.session_id === session.id && current.version_epoch === epoch) {
          const live = nativeRow(table, current);
          for (const field of controls[kind]) if (Object.hasOwn(live, field)) value[field] = live[field];
        }
      }
    } else {
      // A record visible through a previous branch must not resume old execution.
      if (kind === 'runs' && ['running', 'queued', 'waiting_permission', 'waiting_input'].includes(String(row.status))) {
        value.status = 'interrupted'; value.stopReason = 'history_restored';
      }
      if (kind === 'steps' && ['running', 'waiting_permission', 'waiting_input'].includes(String(value.status))) {
        value.status = 'interrupted'; value.finishReason = 'history_restored';
      }
      if (kind === 'tools' && ['pending', 'running'].includes(String(value.status))) {
        value.status = 'failed'; value.error = 'Execution is outside the current history epoch.';
      }
      if (kind === 'permissions' && !value.resolvedAt) Object.assign(value, { action: 'deny', userReply: 'reject', resumeToken: null });
      if (kind === 'interactions' && value.status === 'pending') value.status = 'cancelled';
    }
    return value;
  }

  private *versionRecords(roots: Roots, table: string): Generator<Row> {
    const reference = this.treeGet(roots.stateRoot, `table/${table}`);
    if (!reference) return;
    const manifest = this.json(reference, 'record');
    if (manifest.kind !== 'table' || manifest.version !== 1) throw new Error('Invalid V1 table manifest');
    let count = 0;
    for (const [, ref] of this.treeEntries(manifest.order as string | null)) {
      const { value, order } = this.record(ref, table);
      if (table === 'messages' && value.sequence === undefined) value.sequence = order;
      count++;
      yield value;
    }
    if (count !== manifest.count) throw new Error(`V1 ${table} count differs from its manifest`);
  }

  private record(reference: string, table: string): { value: Row; order: number } {
    const header = this.json(reference, 'record');
    if (header.kind !== 'runtime-record' || header.version !== 1 || header.table !== table) throw new Error('Invalid V1 runtime record');
    const value: Row = {};
    for (const [key, field] of Object.entries(header.fields as Record<string, Row>)) {
      if (Object.hasOwn(field, 'inline')) value[key] = field.inline;
      else {
        const text = this.text(String(field.ref));
        if (Buffer.byteLength(text) !== field.bytes) throw new Error('V1 record field byte count mismatch');
        if (field.encoding === 'json') value[key] = JSON.parse(text);
        else if (field.encoding === 'text') value[key] = text;
        else throw new Error('Unknown V1 field encoding');
      }
    }
    // The 1.x JSONL migration published session records from a temporary staging
    // scope. Its header id can differ; the session payload retains the real id.
    if (table !== 'session' && value.id !== header.id) throw new Error('V1 record identity mismatch');
    return { value, order: Number(header.order) };
  }

  private text(reference: string): string {
    const manifest = this.json(reference, 'record');
    if (manifest.kind !== 'text' || manifest.version !== 1 || Number(manifest.bytes) > 16 * 1024 * 1024) throw new Error('Invalid V1 text manifest');
    const chunks: string[] = [];
    let bytes = 0;
    for (const [key, ref] of this.treeEntries(manifest.root as string | null)) {
      if (key !== String(chunks.length).padStart(10, '0')) throw new Error('V1 text chunk order mismatch');
      const value: unknown = JSON.parse(this.object(ref, 'chunk').bytes.toString('utf8'));
      if (typeof value !== 'string') throw new Error('V1 text chunk is not a string');
      bytes += Buffer.byteLength(value);
      if (bytes > Number(manifest.bytes)) throw new Error('V1 text exceeds declared size');
      chunks.push(value);
    }
    const value = chunks.join('');
    if (chunks.length !== manifest.chunks || bytes !== manifest.bytes || value.length !== manifest.chars) throw new Error('V1 text length mismatch');
    return value;
  }

  private version(reference: string): Roots {
    const version = this.json(reference, 'version');
    if (version.format !== 3 || !version.roots) throw new Error('Invalid V1 version manifest');
    return version.roots as unknown as Roots;
  }

  private tree(reference: string): Tree {
    const stored = this.object(reference, 'tree');
    const node = JSON.parse(stored.bytes.toString('utf8'));
    if (![1, 2].includes(node.v) || !Number.isInteger(node.height) || node.height < 0 || node.height >= 32) throw new Error('Invalid V1 tree');
    const entries: Tree['entries'] = (node.height === 0 ? node.entries : node.children).map((item: [string, string | number, number?]) => [
      item[0], objectId(node.v === 2 ? stored.refs[Number(item[1])] : item[1]), item[2],
    ]);
    let count = 0;
    for (let i = 0; i < entries.length; i++) {
      if (i && entries[i - 1][0] >= entries[i][0]) throw new Error('V1 tree keys are not ordered');
      count += node.height === 0 ? 1 : Number(entries[i][2]);
    }
    if (count !== node.count) throw new Error('V1 tree count mismatch');
    return { height: node.height, count, entries };
  }

  private treeGet(root: string | null, key: string): string | undefined {
    let reference = root;
    for (let depth = 0; reference; depth++) {
      if (depth >= 32) throw new Error('V1 tree depth exceeded');
      const node = this.tree(reference);
      if (node.height === 0) return node.entries.find(entry => entry[0] === key)?.[1];
      reference = node.entries.findLast(entry => entry[0] <= key)?.[1] ?? null;
    }
  }

  private *treeEntries(root: string | null, depth = 0): Generator<[string, string]> {
    if (!root) return;
    if (depth >= 32) throw new Error('V1 tree depth exceeded');
    const node = this.tree(root);
    let count = 0;
    for (const [key, reference] of node.entries) {
      if (node.height === 0) { count++; yield [key, reference]; }
      else for (const entry of this.treeEntries(reference, depth + 1)) { count++; yield entry; }
    }
    if (count !== node.count) throw new Error('V1 tree subtree count mismatch');
  }

  private json(reference: string, kind: string): Row { return JSON.parse(this.object(reference, kind).bytes.toString('utf8')) as Row; }
  private object(reference: string, kind?: string): StoredObject {
    objectId(reference);
    let stored = this.cache.get(reference);
    if (!stored) {
      const row = this.query('SELECT kind,payload,refs,payload_ref FROM conversation_v3_objects WHERE hash=?').get([Buffer.from(reference, 'hex')]) as Row | undefined;
      if (!row) throw new Error(`V1 object missing: ${reference}`);
      const bytes = row.payload_ref ? this.payload(String(row.payload_ref)) : Buffer.from(row.payload as Uint8Array);
      const packed = Buffer.from(row.refs as Uint8Array), refs: string[] = [];
      if (packed.length % 32) throw new Error('V1 object reference vector is malformed');
      for (let i = 0; i < packed.length; i += 32) refs.push(packed.subarray(i, i + 32).toString('hex'));
      const identity = createHash('sha256').update(`synax.checkpoint.v3\0${row.kind}\0${bytes.length}\0`).update(bytes).update('\0').update(refs.join(',')).digest('hex');
      if (identity !== reference) throw new Error(`V1 object checksum mismatch: ${reference}`);
      stored = { kind: String(row.kind), bytes, refs };
      this.cache.set(reference, stored); this.cacheBytes += bytes.length + packed.length;
      while (this.cacheBytes > 8 * 1024 * 1024 || this.cache.size > 2048) {
        const [key, old] = this.cache.entries().next().value!;
        this.cacheBytes -= old.bytes.length + old.refs.length * 32; this.cache.delete(key);
      }
    }
    if (kind && stored.kind !== kind) throw new Error(`V1 object kind mismatch: expected ${kind}, found ${stored.kind}`);
    return stored;
  }

  private payload(reference: string): Buffer {
    objectId(reference);
    const row = this.tables.has('jsonl_payload_records') ? this.query(`SELECT r.*,s.committed_bytes FROM jsonl_payload_records r
      JOIN jsonl_payload_segments s ON s.id=r.segment WHERE r.hash=?`).get(reference) as Row | undefined : undefined;
    const bytes = row ? this.line(path.join(this.root, 'version-jsonl'), row, 'version_payload')
      : readFileSync(path.join(this.root, 'version-payloads', reference.slice(0, 2), reference));
    if (hash(bytes) !== reference) throw new Error('V1 external payload checksum mismatch');
    return bytes;
  }

  private line(root: string, row: Row, kind: string): Buffer {
    if (typeof row.segment !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.segment)) throw new Error('Invalid V1 JSONL segment');
    const offset = Number(row.offset), length = Number(row.length);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 128 * 1024 || offset + length > Number(row.committed_bytes)) throw new Error('V1 JSONL offset exceeds committed data');
    const file = openSync(path.join(root, 'transcripts', `${row.segment}.jsonl`), 'r');
    const bytes = Buffer.alloc(length);
    try {
      let read = 0;
      while (read < length) {
        const count = readSync(file, bytes, read, length - read, offset + read);
        if (!count) throw new Error('Truncated V1 JSONL record');
        read += count;
      }
    } finally { closeSync(file); }
    const value = JSON.parse(bytes.toString('utf8'));
    const body = { version: value.version, hash: value.hash, kind: value.kind, references: value.references, payload: value.payload };
    if (value.version !== 1 || value.hash !== row.hash || value.kind !== kind || hash(JSON.stringify(body)) !== value.checksum) throw new Error('V1 JSONL envelope checksum mismatch');
    const payload = Buffer.from(value.payload, 'base64');
    if (payload.length !== row.payload_bytes || hash(payload) !== row.hash) throw new Error('V1 JSONL payload checksum mismatch');
    return payload;
  }

  private *transcript(sessionId: string): Generator<Row> {
    const head = this.get('transcript_heads', 'session_id', sessionId)!;
    for (const row of this.query('SELECT * FROM transcript_records WHERE session_id=? AND visible=1 AND sequence<=? ORDER BY sequence').iterate(sessionId, head.visible_sequence) as Iterable<Row>) {
      const value = JSON.parse(this.line(this.root, { ...row, segment: head.segment, committed_bytes: head.committed_bytes }, 'message').toString('utf8')) as Row;
      if (value.id !== row.message_id || value.sessionId !== sessionId) throw new Error('V1 transcript identity mismatch');
      yield { ...value, sequence: row.sequence };
    }
  }
}
