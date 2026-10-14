import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import NativeDatabase from 'libsql';

const args = process.argv.slice(2);
const value = (key: string) => { const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1]; };
const root = path.resolve(value('--data-root') ?? process.env.DATA_ROOT ?? path.join(os.homedir(), '.synax'));
const apply = args.includes('--apply');
const databaseFile = path.join(root, 'context.db');
const reportFile = value('--report');
function assertOffline(db: NativeDatabase.Database): void {
  const row = db.prepare('SELECT pid FROM runtime_host_lock WHERE id=1').get() as { pid: number } | undefined;
  if (!row || row.pid === process.pid) return;
  try { process.kill(row.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
  throw new Error(`Runtime ${row.pid} is still active. Stop Synax before applying migration.`);
}
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
const observe = new NativeDatabase(databaseFile, { readonly: true });
const inventory = {
  root,
  sessions: (observe.prepare('SELECT count(*) AS n FROM agent_runtime_sessions').get() as { n: number }).n,
  versions: (observe.prepare('SELECT count(*) AS n FROM conversation_v3_heads').get() as { n: number }).n,
  legacyMessages: (observe.prepare('SELECT count(*) AS n FROM agent_runtime_messages').get() as { n: number }).n,
  versionObjects: (observe.prepare('SELECT count(*) AS n FROM conversation_v3_objects').get() as { n: number }).n,
};
console.log(JSON.stringify({ mode: apply ? 'apply' : 'report', inventory }));
if (!apply) { observe.close(); process.exit(0); }
assertOffline(observe); observe.close();
const backup = path.resolve(value('--backup') ?? path.join(root, 'migration-backups', `jsonl-history-${stamp()}`));
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.mkdirSync(backup, { recursive: false, mode: 0o700 });
const source = new NativeDatabase(databaseFile);
try {
  assertOffline(source);
  source.exec('BEGIN IMMEDIATE');
  try {
    assertOffline(source);
    source.prepare('INSERT OR REPLACE INTO runtime_host_lock(id,host_id,pid) VALUES(1,?,?)').run(`jsonl-migration:${process.pid}`, process.pid);
    source.exec('COMMIT');
  } catch (error) { source.exec('ROLLBACK'); throw error; }
  source.exec(`VACUUM INTO '${path.join(backup, 'context.db').replaceAll("'", "''")}'`);
  for (const directory of ['transcripts','version-payloads','version-jsonl','session-logs','runtime-media','conversation-snapshots']) {
    const file = path.join(root, directory);
    if (fs.existsSync(file)) fs.cpSync(file, path.join(backup, directory), { recursive: true, force: false, errorOnExist: true, dereference: false });
  }
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({ format: 1, inventory, createdAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
} finally { source.close(); }
console.log(JSON.stringify({ backupComplete: backup }));
process.env.DATA_ROOT = root;
process.env.SYNAX_TRANSCRIPT_STORAGE = 'jsonl';
process.env.LOG_LEVEL = 'error';
// Offline migration intentionally uses one direct connection; no IPC SQL costs
// and no running legacy executable can modify the protected source tables.
delete process.env.SYNAX_STORAGE_OWNER_ENDPOINT;
delete process.env.SYNAX_STORAGE_OWNER_TOKEN;
delete process.env.SYNAX_RUNTIME_HOST_ID;
const { getRawSqlite, closeDb } = await import('../services/local-node/infrastructure/database/index.js');
const { migrateJsonlSession } = await import('../services/local-node/modules/agent-runtime/checkpoints/version-runtime/jsonl-migration.js');
const { versionRepository } = await import('../services/local-node/modules/agent-runtime/checkpoints/version-runtime/bridge.js');
const { JsonlVersionPayloads } = await import('../services/local-node/infrastructure/storage/jsonl-version-payloads.js');
const db = getRawSqlite();
const started = Date.now();
const results = [];
try {
  assertOffline(db);
  const conflicts = db.prepare("SELECT session_id,state FROM conversation_v3_migrations WHERE state='copying' UNION ALL SELECT session_id,state FROM conversation_history_operations WHERE state IN ('prepared','applying','recovery_required','fork_preparing')").all();
  if (conflicts.length) throw new Error(`Recover unfinished history operations before migration: ${JSON.stringify(conflicts)}`);
  let converted = 0;
  for (;;) {
    const count = versionRepository().objects.externalize(64);
    if (!count) break;
    converted += count;
    if (converted % 1024 === 0) console.log(JSON.stringify({ phase: 'payloads', converted }));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const ids = db.prepare('SELECT id FROM agent_runtime_sessions WHERE NOT EXISTS(SELECT 1 FROM conversation_v3_deletions d WHERE d.session_id=agent_runtime_sessions.id) ORDER BY created_at,id').all() as { id: string }[];
  for (const { id } of ids) {
    const result = await migrateJsonlSession(id, { offline: true });
    results.push(result);
    console.log(JSON.stringify({ phase: 'sessions', completed: results.length, total: ids.length, ...result }));
  }
  // Validate every physical payload from disk and every immutable object hash,
  // not just the current visible messages. Old checkpoints remain in the closure.
  const payloads = new JsonlVersionPayloads(db, path.join(root, 'version-jsonl'), path.join(root, 'version-payloads'));
  let after = '', validated = 0;
  for (;;) {
    const rows = db.prepare('SELECT hash,payload_bytes FROM jsonl_payload_records WHERE hash>? ORDER BY hash LIMIT 128').all(after) as { hash: string; payload_bytes: number }[];
    if (!rows.length) break;
    for (const row of rows) { const bytes = payloads.get(row.hash); if (bytes.length !== row.payload_bytes || createHash('sha256').update(bytes).digest('hex') !== row.hash) throw new Error('Payload validation failed.'); after = row.hash; validated++; }
  }
  let objectAfter = '';
  for (;;) {
    const rows = db.prepare('SELECT lower(hex(hash)) AS hash FROM conversation_v3_objects WHERE hash>:after ORDER BY hash LIMIT 128').all({ after: Buffer.from(objectAfter, 'hex') }).map(row => row as { hash: string });
    if (!rows.length) break;
    for (const row of rows) { versionRepository().objects.get(row.hash); objectAfter = row.hash; }
  }
  const unmigrated = Number((db.prepare('SELECT count(*) AS n FROM conversation_v3_objects WHERE jsonl_payload=0').get() as { n: number }).n);
  if (unmigrated) throw new Error(`${unmigrated} version payloads still use the old backend.`);
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  if (integrity.integrity_check !== 'ok') throw new Error(`Integrity check failed: ${integrity.integrity_check}`);
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key verification failed.');
  const report = { completed: true, inventory, backup, converted, validatedPayloads: validated, sessions: results, elapsedMs: Date.now() - started, verifiedAt: new Date().toISOString() };
  const target = reportFile ? path.resolve(reportFile) : path.join(backup, 'migration-result.json');
  fs.writeFileSync(target, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ completed: true, migratedSessions: results.length, validated, elapsedMs: report.elapsedMs, report: target }));
} catch (error) {
  const target = reportFile ? path.resolve(reportFile) : path.join(backup, 'migration-result.json');
  fs.writeFileSync(target, JSON.stringify({ completed: false, inventory, backup, sessions: results, error: (error as Error).message, failedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  throw error;
} finally {
  try { db.prepare('DELETE FROM runtime_host_lock WHERE id=1 AND host_id=? AND pid=?').run(`jsonl-migration:${process.pid}`, process.pid); }
  finally { closeDb(); }
}
