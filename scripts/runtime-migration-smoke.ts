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
const { RustRuntimeSupervisor } = await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
const { RuntimeSidecarClient } = await import('../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js');
const env = { ...process.env, SYNAX_RUNTIME_SIDECAR_BIN: path.resolve('runtime-sidecar/target/release/synax-runtime-sidecar') };
try {
  const db = new NativeDatabase(dbPath);
  db.exec(`
    CREATE TABLE agent_runtime_sessions (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, updated_at TEXT);
    CREATE TABLE agent_runtime_runs (id TEXT PRIMARY KEY, session_id TEXT, status TEXT, metadata_json TEXT);
    CREATE TABLE agent_runtime_messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT);
    CREATE TABLE agent_runtime_permissions (id TEXT PRIMARY KEY, session_id TEXT, metadata_json TEXT);
    CREATE TABLE agent_runtime_interactions (id TEXT PRIMARY KEY, session_id TEXT, request_json TEXT);
    CREATE TABLE agent_runtime_events (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, payload_json TEXT);
    CREATE TABLE agent_runtime_stream_records (sequence INTEGER, session_id TEXT, run_id TEXT, kind TEXT, chunk_json TEXT, created_at TEXT);
    CREATE TABLE agent_runtime_run_steps (id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT, step_index INTEGER, status TEXT, metadata_json TEXT);
    CREATE TABLE agent_runtime_run_parts (id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT, step_id TEXT, sequence INTEGER, content TEXT);
    CREATE TABLE agent_runtime_work (id TEXT PRIMARY KEY, session_id TEXT, payload_json TEXT, updated_at TEXT);
    CREATE TABLE agent_runtime_context_bundles (id TEXT PRIMARY KEY, session_id TEXT, blocks_json TEXT);
    CREATE TABLE conversation_history_journal (id TEXT PRIMARY KEY, session_id TEXT, payload_json TEXT);
  `);
  db.prepare('INSERT INTO agent_runtime_sessions VALUES (?, ?, ?, ?)').run('s', 'p', 'completed', '2026-10-16T00:00:00Z');
  db.prepare('INSERT INTO agent_runtime_runs VALUES (?, ?, ?, ?)').run('r', 's', 'completed', '{}');
  db.prepare('INSERT INTO agent_runtime_messages VALUES (?, ?, ?)').run('m', 's', 'hello');
  db.prepare('INSERT INTO agent_runtime_permissions VALUES (?, ?, ?)').run('p1', 's', '{}');
  db.prepare('INSERT INTO agent_runtime_interactions VALUES (?, ?, ?)').run('i1', 's', '{}');
  db.prepare('INSERT INTO agent_runtime_events VALUES (?, ?, ?, ?)').run('e1', 's', 'run_started', '{}');
  db.prepare('INSERT INTO agent_runtime_stream_records VALUES (?, ?, ?, ?, ?, ?)').run(1, 's', 'r', 'message_delta', JSON.stringify({ chunk: { type: 'message_delta', sessionId: 's', runId: 'r', stepId: 'step', delta: 'legacy' }, state: { status: 'completed', activeRunId: null, pendingResumeToken: null, blockedReason: null, updatedAt: '2026-10-16T00:00:00Z' } }), '2026-10-16T00:00:00Z');
  db.prepare('INSERT INTO conversation_history_journal VALUES (?, ?, ?)').run('j1', 's', '{}');
  db.prepare('INSERT INTO agent_runtime_run_steps VALUES (?, ?, ?, ?, ?, ?)').run('step', 's', 'r', 1, 'completed', '{"purpose":"tool evidence"}');
  db.prepare('INSERT INTO agent_runtime_run_parts VALUES (?, ?, ?, ?, ?, ?)').run('part', 's', 'r', 'step', 1, 'native part');
  db.prepare('INSERT INTO agent_runtime_work VALUES (?, ?, ?, ?)').run('work', 's', JSON.stringify({ id: 'work', sessionId: 's', objective: 'migrate history', status: 'completed' }), 'now');
  db.prepare('INSERT INTO agent_runtime_context_bundles VALUES (?, ?, ?)').run('ctx', 's', '[{"content":"keep context"}]');
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
  // Read through the same commands used by the online 2.0 runtime. A legacy.*
  // blob export with an arbitrary head must not satisfy migration acceptance.
  const supervisor = new RustRuntimeSupervisor({ dataRoot: root });
  await supervisor.start();
  const client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const history = async (operation: string) => JSON.parse(new TextDecoder().decode(await client.historyCommand({ sessionId: 's', requestId: operation, operation, payload: {} }))) as { items: Array<Record<string, unknown>> };
  try {
    assert.equal((await history('list_messages')).items[0].content, 'hello');
    assert.equal((await history('list_steps')).items[0].index, 1);
    assert.equal((await history('list_parts')).items[0].content, 'native part');
    assert.equal((await history('list_work')).items[0].objective, 'migrate history');
    assert.deepEqual((await history('list_contexts')).items[0].blocks, [{ content: 'keep context' }]);
    const old = await client.snapshot('s');
    const accepted = await client.admitRun({ sessionId: 's', requestId: 'post-migration-run', bodyHash: 'new-turn', runId: 'r2', epoch: old.epoch, revision: old.revision,
      run: { id: 'r2', sessionId: 's', status: 'queued', startedAt: '2026-10-18T00:00:00Z', metadata: {} } });
    const active = await client.activateRun({ sessionId: 's', requestId: 'post-migration-active', epoch: accepted.epoch, revision: accepted.revision,
      run: { id: 'r2', sessionId: 's', status: 'queued', startedAt: '2026-10-18T00:00:00Z', metadata: {} } });
    await client.appendStream({ sessionId: 's', runId: 'r2', producerId: 'migration-smoke', producerSequence: 1, epoch: active.epoch, revision: active.revision,
      events: [{ kind: 'message', payload: new TextEncoder().encode(JSON.stringify({ schema: 1,
        chunk: { type: 'message', message: { id: 'new', sessionId: 's', runId: 'r2', role: 'assistant', content: 'after migration' } },
        state: { status: 'running', activeRunId: 'r2', pendingResumeToken: null, blockedReason: null, updatedAt: '2026-10-18T00:00:01Z' },
      })) }] });
    await client.historyCommand({ sessionId: 's', requestId: 'post-migration-history', operation: 'reconcile_stream', payload: {} });
    assert.deepEqual((await history('list_messages')).items.map(item => item.content).sort(), ['after migration', 'hello']);
    const fence = await client.snapshot('s');
    await client.finishRun({ sessionId: 's', requestId: 'post-migration-finish', runId: 'r2', epoch: fence.epoch, revision: fence.revision, status: 'completed' });
  } finally { client.close(); await supervisor.stop(); }
  const rebuilt = await invoke('rebuild-index', '--data-root', root);
  assert.match(rebuilt.stdout, /"rebuilt": true/);
  const purged = await invoke('purge-legacy', '--force', '--data-root', root);
  assert.match(purged.stdout, /"purge-legacy"/);
  const afterPurge = new NativeDatabase(dbPath, { readonly: true });
  for (const table of ['agent_runtime_sessions', 'agent_runtime_messages', 'agent_runtime_runs', 'agent_runtime_stream_records', 'agent_runtime_work', 'agent_runtime_context_bundles', 'agent_runtime_events', 'conversation_history_journal'])
    assert.equal(afterPurge.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined, `${table} must be dropped after cutover`);
  afterPurge.close();
  const afterRestart = await invoke('verify-runtime', '--data-root', root, '--input', bundle);
  assert.match(afterRestart.stdout, /"ok": true/);
  console.log('Runtime migration smoke passed: native entity and control import, Rust queries, post-migration turn, purge and index rebuild.');
} finally {
  await rm(root, { recursive: true, force: true });
}
