import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import NativeDatabase from 'libsql';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

type Row = Record<string, unknown>;
type SessionBundle = {
  session: Row;
  tables: Record<string, Row[]>;
};
type MigrationBundle = {
  format: 'synax.runtime.migration.v1';
  createdAt: string;
  source: { database: string };
  sessions: SessionBundle[];
  quarantine: Array<{ sessionId?: string; reason: string }>;
};

const args = process.argv.slice(2);
const command = args[0];
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const dataRoot = path.resolve(option('--data-root', process.env.DATA_ROOT ?? path.join(os.homedir(), '.synax'))!);
const database = path.resolve(option('--database', path.join(dataRoot, 'context.db'))!);
const input = path.resolve(option('--input', path.join(dataRoot, 'runtime-migration-export.json'))!);
const output = path.resolve(option('--output', path.join(dataRoot, 'runtime-migration-export.json'))!);

const tables = [
  'agent_runtime_runs', 'agent_runtime_run_steps', 'agent_runtime_messages', 'agent_runtime_run_parts',
  'agent_runtime_tool_calls', 'agent_runtime_permissions', 'agent_runtime_interactions',
  'agent_runtime_events', 'agent_runtime_stream_records',
];

function usage(): never {
  console.error('usage: npm run runtime:migrate -- <export|import|verify|rebuild-index> [--data-root DIR] [--database FILE] [--input FILE] [--output FILE]');
  process.exit(2);
}

function tableExists(db: NativeDatabase.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function rowsFor(db: NativeDatabase.Database, table: string, sessionId: string): Row[] {
  if (!tableExists(db, table)) return [];
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY rowid`).all(sessionId) as Row[];
  } catch {
    return [];
  }
}

async function exportLegacy(): Promise<void> {
  if (!existsSync(database)) throw new Error(`SQLite database does not exist: ${database}`);
  const db = new NativeDatabase(database, { readonly: true });
  try {
    if (!tableExists(db, 'agent_runtime_sessions')) throw new Error('agent_runtime_sessions is missing.');
    const sessions = db.prepare('SELECT * FROM agent_runtime_sessions ORDER BY id').all() as Row[];
    const bundle: MigrationBundle = {
      format: 'synax.runtime.migration.v1',
      createdAt: new Date().toISOString(),
      source: { database },
      sessions: sessions.map(session => ({
        session,
        tables: Object.fromEntries(tables.map(table => [table, rowsFor(db, table, String(session.id))])),
      })),
      quarantine: [],
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`);
    console.log(JSON.stringify({ command: 'export', output, sessions: bundle.sessions.length }, null, 2));
  } finally {
    db.close();
  }
}

async function loadBundle(): Promise<MigrationBundle> {
  const bundle = JSON.parse(await readFile(input, 'utf8')) as MigrationBundle;
  if (bundle.format !== 'synax.runtime.migration.v1' || !Array.isArray(bundle.sessions)) throw new Error('Unsupported migration bundle.');
  return bundle;
}

function validateBundle(bundle: MigrationBundle): Array<{ sessionId?: string; reason: string }> {
  const quarantine = [...(bundle.quarantine ?? [])];
  const seen = new Set<string>();
  for (const item of bundle.sessions) {
    const sessionId = typeof item.session?.id === 'string' ? item.session.id : undefined;
    if (!sessionId) { quarantine.push({ reason: 'session has no string id' }); continue; }
    if (seen.has(sessionId)) { quarantine.push({ sessionId, reason: 'duplicate session id' }); continue; }
    seen.add(sessionId);
    for (const [table, rows] of Object.entries(item.tables ?? {})) {
      if (!Array.isArray(rows)) quarantine.push({ sessionId, reason: `${table} is not an array` });
      for (const row of rows ?? []) {
        if (row.session_id !== undefined && row.session_id !== sessionId) quarantine.push({ sessionId, reason: `${table} row belongs to another session` });
        for (const [key, value] of Object.entries(row)) {
          if (key.endsWith('_json') && typeof value === 'string' && value.length > 0) {
            try { JSON.parse(value); } catch { quarantine.push({ sessionId, reason: `${table}.${key} is invalid JSON` }); }
          }
        }
      }
    }
  }
  return quarantine;
}

async function verifyBundle(): Promise<void> {
  const bundle = await loadBundle();
  const quarantine = validateBundle(bundle);
  console.log(JSON.stringify({ command: 'verify', input, sessions: bundle.sessions.length, quarantine, ok: quarantine.length === 0 }, null, 2));
  if (quarantine.length) process.exitCode = 1;
}

async function withSidecar<T>(fn: (client: RuntimeSidecarClient) => Promise<T>): Promise<T> {
  const supervisor = new RustRuntimeSupervisor({ dataRoot });
  await supervisor.start();
  const client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  try { return await fn(client); }
  finally { client.close(); await supervisor.stop(); }
}

async function putObject(client: RuntimeSidecarClient, sessionId: string, requestId: string, kind: string, value: unknown, refs: string[] = []): Promise<string> {
  const bytes = await client.historyCommand({ sessionId, requestId, operation: 'put_object', payload: { kind, value, refs } });
  return (JSON.parse(new TextDecoder().decode(bytes)) as { objectId: string }).objectId;
}

async function importBundle(): Promise<void> {
  const bundle = await loadBundle();
  const quarantine = validateBundle(bundle);
  const valid = bundle.sessions.filter(item => {
    const id = typeof item.session?.id === 'string' ? item.session.id : '';
    return id && !quarantine.some(entry => entry.sessionId === id);
  });
  const imported = await withSidecar(async client => {
    let count = 0;
    for (const item of valid) {
      const sessionId = String(item.session.id);
      const existing = JSON.parse(new TextDecoder().decode(await client.historyCommand({ sessionId, requestId: `migrate:${sessionId}:head-read`, operation: 'head_read', payload: {} }))) as { objectId?: string };
      if (existing.objectId) { count++; continue; }
      const chunks: string[] = [];
      for (const [table, rows] of Object.entries(item.tables)) {
        for (let offset = 0; offset < rows.length; offset += 128) {
          const chunk = rows.slice(offset, offset + 128);
          chunks.push(await putObject(client, sessionId, `migrate:${sessionId}:${table}:${offset}`, `legacy.${table}`, { sessionId, table, offset, rows: chunk }));
        }
      }
      const root = await putObject(client, sessionId, `migrate:${sessionId}:root`, 'runtime.session.root', { session: item.session, source: bundle.source }, chunks);
      await client.historyCommand({ sessionId, requestId: `migrate:${sessionId}:head-switch`, operation: 'head_switch', payload: { objectId: root, expectedRevision: 0 } });
      count++;
    }
    return count;
  });
  console.log(JSON.stringify({ command: 'import', input, imported, quarantined: quarantine.length, ok: quarantine.length === 0 }, null, 2));
  if (quarantine.length) process.exitCode = 1;
}

async function rebuildIndex(): Promise<void> {
  const result = await withSidecar(async client => JSON.parse(new TextDecoder().decode(await client.historyCommand({ sessionId: '__system__', requestId: `migrate:rebuild-index:${Date.now()}`, operation: 'rebuild_index', payload: {} }))));
  console.log(JSON.stringify({ command: 'rebuild-index', ...result }, null, 2));
}

if (!command || !['export', 'import', 'verify', 'rebuild-index'].includes(command)) usage();
if (command === 'export') await exportLegacy();
else if (command === 'import') await importBundle();
else if (command === 'verify') await verifyBundle();
else await rebuildIndex();
