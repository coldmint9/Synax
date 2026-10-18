import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import NativeDatabase from 'libsql';
import { isDeepStrictEqual } from 'node:util';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';
import { readHistoryList, readSessionList } from '../services/local-node/modules/agent-runtime/sidecar/history-pages.js';
import { auditV1 } from './runtime-migration/audit.js';
import { exportV1Archive, verifyV1Archive } from './runtime-migration/archive.js';
import { stageV1Archive, verifyV1Stage } from './runtime-migration/stage.js';

import { exportTables, historyTables, nativeEntities, nativeProjection, nativeSession, nativeRow, nativeReplay, type Row, type SessionBundle } from './runtime-migration/records.js';
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
const output = path.resolve(option('--output', path.join(dataRoot, command === 'audit-v1' ? 'runtime-v1-audit.json'
  : command === 'export-v1' ? 'runtime-v1-source.ndjson' : 'runtime-migration-export.json'))!);

const tables = exportTables;

function usage(): never {
  console.error('usage: npm run runtime:migrate -- <audit-v1|export-v1|verify-v1-export|stage-v1|verify-v1-stage|export|import|verify|verify-runtime|rebuild-index|purge-legacy> [--force] [--data-root DIR] [--database FILE] [--input FILE] [--output FILE]');
  process.exit(2);
}

function tableExists(db: NativeDatabase.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function rowsFor(db: NativeDatabase.Database, table: string, sessionId: string): Row[] {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY rowid`).all(sessionId) as Row[];
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

type RuntimeVerificationIssue = { sessionId?: string; reason: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function verifyRuntime(): Promise<void> {
  const expected = existsSync(input)
    ? await loadBundle()
    : undefined;
  const expectedById = new Map<string, SessionBundle>();
  for (const item of expected?.sessions ?? []) {
    if (typeof item.session?.id === 'string') expectedById.set(item.session.id, item);
  }

  const result = await withSidecar(async client => {
    const issues: RuntimeVerificationIssue[] = [];
    const sessions = await readSessionList(client);
    const seen = new Set<string>();

    const historyVerify = asRecord(JSON.parse(new TextDecoder().decode(await client.historyCommand({
      sessionId: '__system__',
      requestId: `verify-runtime:history:${Date.now()}`,
      operation: 'verify',
      payload: {},
    }))));
    if (historyVerify.ok !== true) {
      issues.push({ reason: `runtime-history verification failed: ${JSON.stringify(historyVerify)}` });
    }

    for (const item of sessions) {
      const session = asRecord(item);
      const sessionId = typeof session.id === 'string' ? session.id : undefined;
      if (!sessionId) {
        issues.push({ reason: 'Rust session list contains an item without a string id' });
        continue;
      }
      seen.add(sessionId);
      const expectedItem = expectedById.get(sessionId);
      try {
        const projection = asRecord(JSON.parse(new TextDecoder().decode(await client.uiSnapshot(sessionId))));
        const projectedSession = asRecord(projection.session);
        const hot = await client.snapshot(sessionId);
        if (projectedSession.id !== sessionId) issues.push({ sessionId, reason: 'projection session id mismatch' });
        if ((projectedSession.activeRunId ?? null) !== (hot.activeRunId ?? null)) issues.push({ sessionId, reason: 'projection activeRunId differs from runtime-hot fence' });
        if (projection.cursor !== hot.cursor) issues.push({ sessionId, reason: `projection cursor ${String(projection.cursor)} differs from hot cursor ${String(hot.cursor)}` });

        let cursor = Math.max(0, hot.retainedFrom - 1);
        let delivered = 0;
        for (let page = 0; page < 64 && cursor < hot.cursor; page++) {
          const batch = await client.replay(sessionId, cursor);
          if (batch.events.length === 0) {
            issues.push({ sessionId, reason: `replay ended at ${cursor} before hot cursor ${hot.cursor}` });
            break;
          }
          for (const event of batch.events) {
            if (!Number.isSafeInteger(event.sequence) || event.sequence <= cursor) {
              issues.push({ sessionId, reason: 'replay sequence is not strictly increasing' });
              break;
            }
            cursor = event.sequence;
            delivered++;
          }
        }
        if (cursor !== hot.cursor) issues.push({ sessionId, reason: `replay ended at ${cursor}, expected ${hot.cursor}` });
        if (delivered > 1024) issues.push({ sessionId, reason: 'replay exceeded the bounded retention window' });

        const head = asRecord(JSON.parse(new TextDecoder().decode(await client.historyCommand({
          sessionId,
          requestId: `verify-runtime:head:${sessionId}`,
          operation: 'head_read',
          payload: {},
        }))));
        const hasLegacyRows = expectedItem
          ? Object.values(expectedItem.tables ?? {}).some(rows => Array.isArray(rows) && rows.length > 0)
          : false;
        if (hasLegacyRows && typeof head.objectId !== 'string') {
          issues.push({ sessionId, reason: 'migrated session has legacy rows but no runtime-history head' });
        }

        if (expectedItem) {
          for (const [table, [, operation]] of Object.entries(historyTables)) {
            const expectedRows = (expectedItem.tables[table] ?? []).map(row => nativeRow(table, row));
            const actual = new Map((await readHistoryList<Row>(client, sessionId, operation)).map(row => [row.id, row]));
            for (const row of expectedRows) {
              if (!actual.has(row.id)) { issues.push({ sessionId, reason: `${table}:${row.id} missing from native history` }); continue; }
              for (const [key, value] of Object.entries(row)) {
                if (!isDeepStrictEqual(actual.get(row.id)![key], value))
                  issues.push({ sessionId, reason: `${table}:${row.id}.${key} differs after import` });
              }
            }
          }
          const fence = await client.snapshot(sessionId);
          const controlReply = await client.controlCommand({ sessionId, requestId: `verify-control:${sessionId}`, operation: 'read', epoch: fence.epoch, revision: fence.revision });
          const controls = asRecord(JSON.parse(new TextDecoder().decode(controlReply.stateJson)));
          for (const [table, field] of [['agent_runtime_permissions', 'permissions'], ['agent_runtime_interactions', 'interactions']]) {
            const source = nativeProjection(expectedItem).control[field as 'permissions' | 'interactions'];
            if (!isDeepStrictEqual(controls[field], source)) issues.push({ sessionId, reason: `${field} differ after import` });
          }
          const legacySession = nativeSession(expectedItem);
          for (const key of ['id', 'project_id', 'status'] as const) {
            const expectedValue = legacySession[key === 'project_id' ? 'projectId' : key];
            const actualKey = key === 'project_id' ? 'projectId' : key;
            if (expectedValue !== undefined && session[actualKey] !== expectedValue) {
              issues.push({ sessionId, reason: `session field ${actualKey} differs from migration input` });
            }
          }
        }
      } catch (error) {
        issues.push({ sessionId, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    for (const sessionId of expectedById.keys()) {
      if (!seen.has(sessionId)) issues.push({ sessionId, reason: 'migration input session is missing from Rust session list' });
    }
    return { sessions: sessions.length, issues };
  });

  console.log(JSON.stringify({ command: 'verify-runtime', input: existsSync(input) ? input : undefined, ...result, ok: result.issues.length === 0 }, null, 2));
  if (result.issues.length) process.exitCode = 1;
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
      await client.importProjection(sessionId, new TextEncoder().encode(JSON.stringify(nativeProjection(item))));
      const refs: string[] = [];
      for (const { kind, value } of nativeEntities(item)) {
        refs.push(await putObject(client, sessionId, `migrate:v2:${sessionId}:${kind}:${value.id}`, kind, value));
      }
      // Root fanout stays within a bounded control frame regardless of row count.
      let level = refs;
      for (let depth = 0; level.length > 256; depth++) {
        const next: string[] = [];
        for (let offset = 0; offset < level.length; offset += 256) {
          next.push(await putObject(client, sessionId, `migrate:v2:${sessionId}:chunk:${depth}:${offset}`,
            'runtime.session.root.chunk', { sessionId }, level.slice(offset, offset + 256)));
        }
        level = next;
      }
      const root = await putObject(client, sessionId, `migrate:v2:${sessionId}:root`, 'runtime.session.root', { sessionId }, level);
      await client.historyCommand({ sessionId, requestId: `migrate:v2:${sessionId}:publish`, operation: 'head_switch', payload: { objectId: root, expectedRevision: 0 } });
      const replay = nativeReplay(item);
      if (replay.length) await client.importStream(sessionId, new TextEncoder().encode(JSON.stringify(replay)));
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

async function purgeLegacy(): Promise<void> {
  if (!args.includes('--force')) throw new Error('purge-legacy requires --force after an offline export/import/verify pass.');
  if (!existsSync(database)) throw new Error(`SQLite database does not exist: ${database}`);
  const db = new NativeDatabase(database);
  const tables = [...exportTables, 'agent_runtime_sessions', 'conversation_history_journal'];
  const deleted: Record<string, number> = {};
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    for (const table of tables) {
      if (!tableExists(db, table)) continue;
      deleted[table] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);
      db.exec(`DROP TABLE "${table}"`);
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  console.log(JSON.stringify({ command: 'purge-legacy', database, deleted, force: true }, null, 2));
}

if (!command || !['stage-v1', 'verify-v1-stage', 'audit-v1', 'export-v1', 'verify-v1-export', 'export', 'import', 'verify', 'verify-runtime', 'rebuild-index', 'purge-legacy'].includes(command)) usage();
if (command === 'audit-v1') await auditV1(dataRoot, database, output);
else if (command === 'export-v1') console.log(JSON.stringify({ command, output, ...await exportV1Archive(dataRoot, database, output), ok: true }, null, 2));
else if (command === 'verify-v1-export') console.log(JSON.stringify({ command, input, ...await verifyV1Archive(input), ok: true }, null, 2));
else if (command === 'stage-v1' || command === 'verify-v1-stage') {
  const result = await withSidecar(client => command === 'stage-v1' ? stageV1Archive(input, client) : verifyV1Stage(input, client));
  await writeFile(path.join(dataRoot, `${command}-result.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ command, dataRoot, ...result }, null, 2));
}
else if (command === 'export') await exportLegacy();
else if (command === 'import') await importBundle();
else if (command === 'verify') await verifyBundle();
else if (command === 'verify-runtime') await verifyRuntime();
else if (command === 'rebuild-index') await rebuildIndex();
else await purgeLegacy();
