import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-cutover-'));
try {
  Object.assign(process.env, {
    DATA_ROOT: root,
    NODE_ENV: 'production',
    SYNAX_RUNTIME_SIDECAR_STREAM: 'authoritative',
    SYNAX_RUNTIME_SIDECAR_SUPERVISOR: '0',
  });
  const { getRawSqlite, closeDb } = await import('../services/local-node/infrastructure/database/index.js');
  const db = getRawSqlite();
  assert.equal(typeof db.prepare, 'function');
  db.prepare('CREATE TABLE cutover_probe(id INTEGER PRIMARY KEY)').run();
  db.prepare('INSERT INTO cutover_probe VALUES (1)').run();
  assert.equal((db.prepare('SELECT count(*) AS n FROM cutover_probe').get() as { n: number }).n, 1);
  closeDb();
  console.log('Authoritative cutover smoke passed: direct SQLite compatibility reads/writes remain available to Node execution context, while Rust owns runtime stream/control paths.');
} finally {
  await rm(root, { recursive: true, force: true });
}
