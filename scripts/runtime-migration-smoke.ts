import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import NativeDatabase from 'libsql';

const run = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-migration-'));
const dbPath = path.join(root, 'context.db');
const bundle = path.join(root, 'export.json');
const env = { ...process.env, SYNAX_RUNTIME_SIDECAR_BIN: path.resolve('runtime-sidecar/target/release/synax-runtime-sidecar') };
try {
  const db = new NativeDatabase(dbPath);
  db.exec(`
    CREATE TABLE agent_runtime_sessions (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, updated_at TEXT);
    CREATE TABLE agent_runtime_runs (id TEXT PRIMARY KEY, session_id TEXT, status TEXT, metadata_json TEXT);
    CREATE TABLE agent_runtime_messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT);
    CREATE TABLE agent_runtime_permissions (id TEXT PRIMARY KEY, session_id TEXT, metadata_json TEXT);
    CREATE TABLE agent_runtime_interactions (id TEXT PRIMARY KEY, session_id TEXT, request_json TEXT);
    CREATE TABLE agent_runtime_stream_records (sequence INTEGER, session_id TEXT, run_id TEXT, kind TEXT, chunk_json TEXT, created_at TEXT);
  `);
  db.prepare('INSERT INTO agent_runtime_sessions VALUES (?, ?, ?, ?)').run('s', 'p', 'completed', '2026-10-16T00:00:00Z');
  db.prepare('INSERT INTO agent_runtime_runs VALUES (?, ?, ?, ?)').run('r', 's', 'completed', '{}');
  db.prepare('INSERT INTO agent_runtime_messages VALUES (?, ?, ?)').run('m', 's', 'hello');
  db.prepare('INSERT INTO agent_runtime_permissions VALUES (?, ?, ?)').run('p1', 's', '{}');
  db.prepare('INSERT INTO agent_runtime_interactions VALUES (?, ?, ?)').run('i1', 's', '{}');
  db.prepare('INSERT INTO agent_runtime_stream_records VALUES (?, ?, ?, ?, ?, ?)').run(1, 's', 'r', 'message_delta', JSON.stringify({ chunk: { type: 'message_delta', sessionId: 's', runId: 'r', stepId: 'step', delta: 'legacy' }, state: { status: 'completed', activeRunId: null, pendingResumeToken: null, blockedReason: null, updatedAt: '2026-10-16T00:00:00Z' } }), '2026-10-16T00:00:00Z');
  db.close();

  const cli = path.resolve('scripts/synax-runtime-migrate.ts');
  const invoke = async (...args: string[]) => run(process.execPath, ['--import', 'tsx/esm', cli, ...args], { env });
  await invoke('export', '--data-root', root, '--output', bundle);
  const exported = JSON.parse(await readFile(bundle, 'utf8')) as { sessions: unknown[] };
  assert.equal(exported.sessions.length, 1);
  await invoke('verify', '--data-root', root, '--input', bundle);
  await invoke('import', '--data-root', root, '--input', bundle);
  const runtime = await invoke('verify-runtime', '--data-root', root, '--input', bundle);
  assert.match(runtime.stdout, /"ok": true/);
  const rebuilt = await invoke('rebuild-index', '--data-root', root);
  assert.match(rebuilt.stdout, /"rebuilt": true/);
  console.log('Runtime migration smoke passed: SQLite export, quarantine-aware verify, immutable history import and index rebuild.');
} finally {
  await rm(root, { recursive: true, force: true });
}
