import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'libsql';
import { V1Reader, type V1Record } from './v1-reader.js';
import { exportV1Archive, verifyV1Archive } from './archive.js';
import type { Row } from './records.js';

let root: string, db: Database.Database;
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'synax-v1-reader-'));
  db = new Database(path.join(root, 'context.db'));
  db.exec(`
    CREATE TABLE agent_runtime_sessions(id TEXT PRIMARY KEY, status TEXT, prompt TEXT, session_metadata_json TEXT);
    CREATE TABLE agent_runtime_messages(id TEXT PRIMARY KEY, session_id TEXT, content TEXT, sequence INTEGER);
    CREATE TABLE agent_runtime_events(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, payload_json TEXT);
    CREATE TABLE conversation_v3_heads(session_id TEXT PRIMARY KEY,version_id BLOB,epoch INTEGER,boundary_only INTEGER,full_history INTEGER,legacy_runtime INTEGER,checkpoint_root BLOB);
    CREATE TABLE conversation_v3_objects(hash BLOB PRIMARY KEY,kind TEXT,payload BLOB,refs BLOB,payload_ref TEXT);
    CREATE TABLE conversation_v3_runtime_records(session_id TEXT,kind TEXT,record_id TEXT,epoch INTEGER,sequence INTEGER);
    CREATE TABLE conversation_flat_heads(session_id TEXT PRIMARY KEY);
    CREATE TABLE jsonl_payload_records(hash TEXT PRIMARY KEY,segment TEXT,offset INTEGER,length INTEGER,payload_bytes INTEGER);
    CREATE TABLE jsonl_payload_segments(id TEXT PRIMARY KEY,committed_bytes INTEGER);
    CREATE TABLE transcript_heads(session_id TEXT PRIMARY KEY,segment TEXT,visible_sequence INTEGER,committed_bytes INTEGER);
    CREATE TABLE transcript_records(session_id TEXT,message_id TEXT,sequence INTEGER,offset INTEGER,length INTEGER,payload_bytes INTEGER,hash TEXT,visible INTEGER);
  `);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

function envelope(payload: Buffer, kind: string, segment: string, directory = root) {
  const body = { version: 1, hash: sha(payload), kind, references: [], payload: payload.toString('base64') };
  const bytes = Buffer.from(JSON.stringify({ ...body, checksum: sha(JSON.stringify(body)) }) + '\n');
  mkdirSync(path.join(directory, 'transcripts'), { recursive: true });
  writeFileSync(path.join(directory, 'transcripts', `${segment}.jsonl`), bytes);
  return { hash: body.hash, length: bytes.length, payloadBytes: payload.length };
}
function object(kind: string, value: unknown, references: string[] = [], external?: 'jsonl' | 'binary'): string {
  const payload = Buffer.from(JSON.stringify(value)), refs = [...new Set(references)].sort();
  const id = createHash('sha256').update(`synax.checkpoint.v3\0${kind}\0${payload.length}\0`).update(payload).update('\0').update(refs.join(',')).digest('hex');
  const payloadRef = external ? sha(payload) : null;
  if (external === 'jsonl') {
    const loc = envelope(payload, 'version_payload', id, path.join(root, 'version-jsonl'));
    db.prepare('INSERT INTO jsonl_payload_segments VALUES (?,?)').run(id, loc.length);
    db.prepare('INSERT INTO jsonl_payload_records VALUES (?,?,0,?,?)').run(loc.hash, id, loc.length, loc.payloadBytes);
  } else if (external === 'binary') {
    const dir = path.join(root, 'version-payloads', payloadRef!.slice(0, 2));
    mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, payloadRef!), payload);
  }
  db.prepare('INSERT OR IGNORE INTO conversation_v3_objects VALUES (?,?,?,?,?)').run(Buffer.from(id, 'hex'), kind,
    external ? Buffer.alloc(0) : payload, Buffer.concat(refs.map(ref => Buffer.from(ref, 'hex'))), payloadRef);
  return id;
}
function tree(entries: Array<[string, string]>, compact = true): string | null {
  if (!entries.length) return null;
  const refs = [...new Set(entries.map(([, ref]) => ref))].sort();
  return object('tree', { v: compact ? 2 : 1, height: 0, count: entries.length,
    entries: entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, ref]) => [key, compact ? refs.indexOf(ref) : ref]) }, refs);
}
function record(table: string, id: string, fields: Row, order = 1) {
  return object('record', { kind: 'runtime-record', version: 1, table, scope: 's', id, order,
    fields: Object.fromEntries(Object.entries(fields).map(([key, inline]) => [key, { inline }])) });
}
function version(session: Row, tables: Record<string, string[]> = {}, aggregateRoot: string | null = null) {
  const entries: Array<[string, string]> = [['session', record('session', 'jsonl_migration_staging', session)]];
  for (const [name, refs] of Object.entries(tables)) {
    const order = tree(refs.map((ref, i) => [String(i).padStart(10, '0'), ref]));
    entries.push([`table/${name}`, object('record', { kind: 'table', version: 1, ids: order, order, count: refs.length, next: refs.length + 1 }, order ? [order] : [])]);
  }
  const stateRoot = tree(entries, false);
  return object('version', { format: 3, roots: { stateRoot, aggregateRoot, transcriptRoot: null, sessionTreeRoot: null, fileManifestRoot: null } }, [stateRoot!, ...(aggregateRoot ? [aggregateRoot] : [])]);
}
function addSession() { db.prepare('INSERT INTO agent_runtime_sessions VALUES (?,?,?,?)').run('s', 'completed', 'stale SQL prompt', '{"permissionTier":"live","oldOnly":true}'); }
function read(): V1Record[] {
  const reader = new V1Reader(root);
  try { return [...reader.sessions()].flatMap(session => [...reader.records(session)]); }
  finally { reader.close(); }
}

describe('offline 1.x reader', () => {
  it('reads immutable records, compact and original trees, external chunks and live session fields without SQL shadow rows', () => {
    addSession();
    const first = object('chunk', '完整内容 ', [], 'jsonl'), second = object('chunk', '😀', [], 'binary');
    const chunkTree = tree([['0000000000', first], ['0000000001', second]])!;
    const content = '完整内容 😀';
    const text = object('record', { kind: 'text', version: 1, bytes: Buffer.byteLength(content), chars: content.length, chunks: 2, root: chunkTree }, [chunkTree]);
    const message = object('record', { kind: 'runtime-record', version: 1, table: 'messages', scope: 'staging', id: 'm', order: 7,
      fields: { id: { inline: 'm' }, sessionId: { inline: 's' }, content: { ref: text, encoding: 'text', bytes: Buffer.byteLength(content) } } }, [text]);
    const step = record('steps', 'step', { id: 'step', sessionId: 's', index: 3 });
    const work = record('work', 'work', { id: 'work', sessionId: 's', objective: 'preserve' });
    const head = version({ id: 's', prompt: 'immutable prompt', sessionMetadata: { permissionTier: 'old', kept: true } }, { messages: [message], steps: [step], work: [work] });
    db.prepare('INSERT INTO conversation_v3_heads VALUES (?, ?, 2, 0, 1, 0, NULL)').run('s', Buffer.from(head, 'hex'));
    db.prepare('INSERT INTO agent_runtime_messages VALUES (?,?,?,?)').run('stale', 's', 'must not resurrect', 1);
    const before = sha(readFileSync(path.join(root, 'context.db')));
    const reader = new V1Reader(root);
    try {
      const session = [...reader.sessions()][0];
      expect(session.session.prompt).toBe('immutable prompt');
      expect(session.session.sessionMetadata).toEqual({ permissionTier: 'live', kept: true });
      const rows = [...reader.records(session)];
      expect(rows.map(row => row.value.id)).toEqual(['m', 'step', 'work']);
      expect(rows[0].value).toMatchObject({ content, sequence: 7 });
      expect(rows[1].value.index).toBe(3);
      expect(rows[2].value.objective).toBe('preserve');
    } finally { reader.close(); }
    expect(sha(readFileSync(path.join(root, 'context.db')))).toBe(before);
  });

  it('respects rollback epoch visibility and legacy untracked rows for boundary-only sessions', () => {
    addSession();
    const boundary = object('record', { through: 2 });
    const old = record('events', 'immutable-shadow', { id: 'immutable-shadow', sessionId: 's', type: 'event' });
    const head = version({ id: 's', prompt: 'p', sessionMetadata: {} }, { events: [old] }, tree([['0000000001', boundary]]));
    // full_history does not override boundary_only for diagnostic entities.
    db.prepare('INSERT INTO conversation_v3_heads VALUES (?, ?, 3, 1, 1, 0, NULL)').run('s', Buffer.from(head, 'hex'));
    for (const [id, epoch, sequence] of [['visible', 1, 2], ['rolled-back', 1, 3], ['wrong-branch', 2, 1], ['current', 3, 8], ['untracked', 0, 0]] as const) {
      db.prepare('INSERT INTO agent_runtime_events VALUES (?,?,?,?)').run(id, 's', 'event', '{}');
      if (epoch) db.prepare('INSERT INTO conversation_v3_runtime_records VALUES (?,?,?,?,?)').run('s', 'events', id, epoch, sequence);
    }
    expect(read().map(row => row.value.id)).toEqual(['visible', 'current']);
    db.prepare('UPDATE conversation_v3_heads SET legacy_runtime=1').run();
    expect(read().map(row => row.value.id)).toEqual(['untracked', 'visible', 'current']);
  });

  it('reads visible transcript bytes but gives a flat head precedence over an obsolete transcript copy', () => {
    addSession();
    const loc = envelope(Buffer.from(JSON.stringify({ id: 'm', sessionId: 's', content: 'from file' })), 'message', 'segment');
    db.prepare('INSERT INTO transcript_heads VALUES (?, ?, 1, ?)').run('s', 'segment', loc.length);
    db.prepare('INSERT INTO transcript_records VALUES (?, ?, 1, 0, ?, ?, ?, 1)').run('s', 'm', loc.length, loc.payloadBytes, loc.hash);
    expect(read()[0].value).toMatchObject({ id: 'm', content: 'from file', sequence: 1 });
    db.prepare('INSERT INTO conversation_flat_heads VALUES (?)').run('s');
    db.prepare('INSERT INTO agent_runtime_messages VALUES (?,?,?,?)').run('flat', 's', 'current', 4);
    expect(read().map(row => row.value.id)).toEqual(['flat']);
  });

  it('reads append-only work from SQL and prevents an ancestor permission from retaining a resume token', () => {
    addSession();
    db.exec(`ALTER TABLE conversation_v3_heads ADD COLUMN rollback_enabled INTEGER DEFAULT 0;
      CREATE TABLE agent_runtime_work(id TEXT,session_id TEXT,payload_json TEXT);
      CREATE TABLE agent_runtime_permissions(id TEXT,session_id TEXT,action TEXT,resume_token TEXT,resolved_at TEXT);`);
    const boundary = object('record', { through: 2 });
    const shadow = record('work', 'old', { id: 'old', sessionId: 's', objective: 'stale' });
    const head = version({ id: 's', prompt: 'p', sessionMetadata: {} }, { work: [shadow] }, tree([['0000000001', boundary]]));
    db.prepare('INSERT INTO conversation_v3_heads VALUES (?, ?, 3, 1, 1, 0, NULL, 0)').run('s', Buffer.from(head, 'hex'));
    db.prepare('INSERT INTO agent_runtime_work VALUES (?,?,?)').run('work', 's', '{"id":"work","sessionId":"s","objective":"current"}');
    db.prepare('INSERT INTO conversation_v3_runtime_records VALUES (?,?,?,?,?)').run('s', 'work', 'work', 3, 1);
    db.prepare('INSERT INTO agent_runtime_permissions VALUES (?,?,?,?,NULL)').run('old-permission', 's', 'ask', 'obsolete-token');
    db.prepare('INSERT INTO conversation_v3_runtime_records VALUES (?,?,?,?,?)').run('s', 'permissions', 'old-permission', 1, 2);
    const rows = read();
    expect(rows.find(row => row.table === 'agent_runtime_work')?.value).toMatchObject({ id: 'work', objective: 'current' });
    expect(rows.find(row => row.table === 'agent_runtime_permissions')?.value).toMatchObject({ action: 'deny', userReply: 'reject', resumeToken: null });
  });

  it('applies same-epoch live controls to immutable content without leaking the old epoch marker', () => {
    addSession();
    db.exec('CREATE TABLE agent_runtime_run_steps(id TEXT,session_id TEXT,status TEXT,completed_at TEXT,version_epoch INTEGER)');
    const step = record('steps', 'step', { id: 'step', sessionId: 's', index: 4, status: 'running', __synaxExecutionEpoch: 3 });
    const head = version({ id: 's', prompt: 'p', sessionMetadata: {} }, { steps: [step] });
    db.prepare('INSERT INTO conversation_v3_heads VALUES (?, ?, 3, 0, 1, 0, NULL)').run('s', Buffer.from(head, 'hex'));
    db.prepare('INSERT INTO agent_runtime_run_steps VALUES (?,?,?,?,?)').run('step', 's', 'completed', 'now', 3);
    const value = read()[0].value;
    expect(value).toMatchObject({ status: 'completed', completedAt: 'now', index: 4 });
    expect(Object.keys(value).some(key => key.includes('Epoch'))).toBe(false);
  });

  it('rejects a changed JSONL body before it can be imported', () => {
    addSession();
    const loc = envelope(Buffer.from(JSON.stringify({ id: 'm', sessionId: 's', content: 'original' })), 'message', 'segment');
    db.prepare('INSERT INTO transcript_heads VALUES (?, ?, 1, ?)').run('s', 'segment', loc.length);
    db.prepare('INSERT INTO transcript_records VALUES (?, ?, 1, 0, ?, ?, ?, 1)').run('s', 'm', loc.length, loc.payloadBytes, loc.hash);
    const file = path.join(root, 'transcripts', 'segment.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"version":1', '"version":2'));
    expect(read).toThrow('V1 JSONL envelope checksum mismatch');
  });

  it('exports a self-contained stream with retained objects and chunked assets, and rejects incomplete or changed archives', async () => {
    addSession();
    const message = record('messages', 'm', { id: 'm', sessionId: 's', content: 'archive evidence' });
    const head = version({ id: 's', prompt: 'p', sessionMetadata: {} }, { messages: [message] });
    const oldMessage = record('messages', 'previous', { id: 'previous', sessionId: 's', content: 'checkpoint-only evidence' });
    const oldVersion = version({ id: 's', prompt: 'p', sessionMetadata: {} }, { messages: [oldMessage] });
    const checkpoint = object('record', { id: 'vcp_1_old', sessionId: 's', ordinal: 1, kind: 'reply', messageId: 'previous',
      payload: { version: 3, versionId: oldVersion } }, [oldVersion]);
    const checkpoints = tree([['0000000001', checkpoint]])!;
    db.prepare('INSERT INTO conversation_v3_heads VALUES (?, ?, 1, 1, 1, 0, ?)').run('s', Buffer.from(head, 'hex'), Buffer.from(checkpoints, 'hex'));
    const asset = Buffer.alloc(300 * 1024, 42);
    db.exec('CREATE TABLE agent_runtime_assets(id TEXT PRIMARY KEY,size INTEGER,sha256 TEXT); CREATE TABLE agent_runtime_asset_sessions(asset_id TEXT,session_id TEXT)');
    db.prepare('INSERT INTO agent_runtime_assets VALUES (?,?,?)').run('asset', asset.length, sha(asset));
    db.prepare('INSERT INTO agent_runtime_asset_sessions VALUES (?,?)').run('asset', 's');
    mkdirSync(path.join(root, 'runtime-media')); writeFileSync(path.join(root, 'runtime-media', 'asset'), asset);
    const output = path.join(root, 'source.ndjson');
    const counts = await exportV1Archive(root, path.join(root, 'context.db'), output);
    expect(counts).toMatchObject({ sessions: 1, records: 1, checkpoints: 1, assets: 1, assetBytes: asset.length, assetBindings: 1 });
    expect(counts.objects).toBeGreaterThan(0);
    // Verification can succeed with no source files or SQLite access.
    rmSync(path.join(root, 'runtime-media'), { recursive: true });
    expect(await verifyV1Archive(output)).toEqual(counts);
    const saved = readFileSync(output, 'utf8');
    expect(saved.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(row => row.type === 'object' && row.id === oldVersion)).toBe(true);
    writeFileSync(output, saved.trimEnd().split('\n').slice(0, -1).join('\n') + '\n');
    await expect(verifyV1Archive(output)).rejects.toThrow('footer missing');
    writeFileSync(output, saved.replace('archive evidence', 'changed evidence'));
    await expect(verifyV1Archive(output)).rejects.toThrow('footer verification failed');
  });
});
