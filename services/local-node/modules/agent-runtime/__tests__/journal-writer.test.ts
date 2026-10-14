import { createServer } from 'node:http';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { JournalWriter } from '../journal-writer.js';
import { HOST_BUSY_TIMEOUT_MS, getRawSqlite } from '../../../infrastructure/database/index.js';
import { MAX_PENDING_JOURNAL_COMMITS, journalWriteLockBudgetMs } from '../../../infrastructure/database/write-contention.js';
import { historyEpoch } from '../checkpoints/guards.js';
import { runtimeJournal } from '../runtime-journal.js';
import { DELTA_FLUSH_MS, RuntimeStreamWriter } from '../runtime-stream-writer.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { plannerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

let writer: JournalWriter;
beforeEach(() => { resetAgentRuntimeFixtures(); writer = new JournalWriter(); });
afterEach(async () => { await writer.close(); });

/** Pin the journal child's write-lock budget. These tests exercise lock waits in
 * milliseconds while the shipped default is seconds. */
async function withLockWait<T>(waitMs: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS;
  process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS = String(waitMs);
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS;
    else process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS = previous;
  }
}

function fixture() {
  const session = agentSessionRuntime.create(plannerSessionInput);
  const run = agentRuntimeStore.appendRun({ id: `run-${session.id}`, sessionId: session.id, status: 'running',
    startedAt: new Date().toISOString(), completedAt: null, triggerMessageId: null, currentStep: 0,
    stopReason: null, model: null, metadata: {} });
  return { session, run, revision: historyEpoch(session.id) };
}

it('commits five concurrent streams in order and acknowledges durable rows', async () => {
  const fixtures = Array.from({ length: 5 }, fixture);
  await Promise.all(fixtures.map(async ({ session, run, revision }) => {
    await writer.append(session.id, run.id, [{ type: 'run_started', run }], revision);
    expect(runtimeJournal.read(session.id)).toHaveLength(1);
    await writer.append(session.id, run.id, [{ type: 'done', sessionId: session.id, runId: run.id }], revision);
    expect(runtimeJournal.read(session.id).map(row => row.chunk.type)).toEqual(['run_started', 'done']);
  }));
});

it('bounds pending IPC writes while the writer is blocked', async () => {
  const { session, run, revision } = fixture();
  const chunks = [{ type: 'run_started' as const, run }];
  await writer.append(session.id, run.id, chunks, revision);
  const db = getRawSqlite();
  db.exec('BEGIN IMMEDIATE');
  const pending = Array.from({ length: MAX_PENDING_JOURNAL_COMMITS },
    () => writer.append(session.id, run.id, chunks, revision));
  const all = Promise.all(pending);
  try {
    await expect(writer.append(session.id, run.id, chunks, revision)).rejects.toThrow('bounded queue');
  } finally {
    db.exec('ROLLBACK');
    await all;
  }
});

it('admits enough commits to cover a full write-lock wait budget', () => {
  delete process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS;
  // The stream writer emits at most one coalesced delta per flush, so the
  // admission limit must outlast the child's whole wait budget. Otherwise a
  // contended commit would be replaced by a full queue: the same failed Run.
  expect(MAX_PENDING_JOURNAL_COMMITS * DELTA_FLUSH_MS).toBeGreaterThanOrEqual(
    journalWriteLockBudgetMs(),
  );
});

it('surfaces a timer-flush failure at the acknowledgement barrier', async () => {
  const { session, run } = fixture();
  const stream = new RuntimeStreamWriter(session.id, run.id, () => true, async () => { throw new Error('disk full'); });
  stream.write({ type: 'message_delta', runId: run.id, stepId: 's', delta: 'hello' });
  await new Promise(resolve => setTimeout(resolve, 80));
  await expect(stream.settled()).rejects.toThrow('disk full');
  stream.abandon();
});

it('drains accepted commits before shutdown and refuses new writes', async () => {
  const { session, run, revision } = fixture();
  const chunks = [{ type: 'run_started' as const, run }];
  const pending = writer.append(session.id, run.id, chunks, revision);
  const closing = writer.close();
  await expect(writer.append(session.id, run.id, chunks, revision)).rejects.toThrow('closed');
  await Promise.all([pending, closing]);
  expect(runtimeJournal.read(session.id)).toHaveLength(1);
});

it('confirms failed child termination before shutdown completes', async () => {
  const { session, run, revision } = fixture();
  const chunks = [{ type: 'run_started' as const, run }];
  await writer.append(session.id, run.id, chunks, revision);
  const child = (writer as unknown as { child: ChildProcess }).child;
  let exited = false;
  child.once('close', () => { exited = true; });
  // A transport failure can precede actual process termination.
  child.emit('error', new Error('IPC transport failed'));
  await expect(writer.append(session.id, run.id, chunks, revision)).rejects.toThrow('has not exited');
  await writer.close();
  expect(exited).toBe(true);
});

it('serves HTTP while five journal writes wait for a SQLite write lock', async () => {
  const fixtures = Array.from({ length: 5 }, fixture);
  const first = fixtures[0];
  // Warm initialization outside the measurement, using the real child process.
  await writer.append(first.session.id, first.run.id, [{ type: 'run_started', run: first.run }], first.revision);
  const db = getRawSqlite();
  let locked = false;
  const server = createServer((_req, response) => {
    db.prepare('SELECT COUNT(*) FROM agent_runtime_sessions').get();
    response.end(JSON.stringify({ locked }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  let completed = false;
  db.exec('BEGIN IMMEDIATE');
  locked = true;
  const writes = Promise.all(fixtures.map(({ session, run, revision }) =>
    writer.append(session.id, run.id, [{ type: 'done', sessionId: session.id, runId: run.id }], revision)));
  void writes.then(() => { completed = true; }, () => {});
  const watchdog = setTimeout(() => { if (locked) { db.exec('ROLLBACK'); locked = false; } }, 700);
  try {
    // Allow IPC delivery while the competing transaction retains its lock.
    await new Promise(resolve => setTimeout(resolve, 50));
    const responses = await Promise.all(Array.from({ length: 5 }, async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      return response.json();
    }));
    expect(responses).toEqual(Array.from({ length: 5 }, () => ({ locked: true })));
    expect(completed).toBe(false);
  } finally {
    clearTimeout(watchdog);
    if (locked) { db.exec('ROLLBACK'); locked = false; }
    await writes;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  expect(completed).toBe(true);
});

it('rejects stale history and invalid execution leases without recording rows', async () => {
  const { session, run, revision } = fixture();
  const chunks = [{ type: 'run_started' as const, run }];
  await expect(writer.append(session.id, run.id, chunks, revision + 1)).rejects.toThrow('Obsolete');
  await expect(writer.append(session.id, run.id, chunks, revision, {
    sessionId: session.id, runId: run.id, epoch: 'invalid', hostId: 'test',
  })).rejects.toThrow(/lease|superseded/i);
  expect(runtimeJournal.read(session.id)).toEqual([]);
  await writer.append(session.id, run.id, chunks, revision);
  expect(runtimeJournal.read(session.id)).toHaveLength(1);
});

it('propagates database lock failure and recovers without retrying uncertain writes', async () => {
  await withLockWait(200, async () => {
    const { session, run, revision } = fixture();
    await writer.append(session.id, run.id, [{ type: 'run_started', run }], revision);
    const db = getRawSqlite();
    db.exec('BEGIN IMMEDIATE');
    try {
      await expect(writer.append(session.id, run.id, [{ type: 'done', sessionId: session.id, runId: run.id }], revision))
        .rejects.toThrow(/locked|busy/i);
    } finally { db.exec('ROLLBACK'); }
    expect(runtimeJournal.read(session.id)).toHaveLength(1);
    await writer.append(session.id, run.id, [{ type: 'done', sessionId: session.id, runId: run.id }], revision);
    expect(runtimeJournal.read(session.id)).toHaveLength(2);
  });
}, 20_000);

it('waits out a write lock that outlives the host busy timeout', async () => {
  const { session, run, revision } = fixture();
  await writer.append(session.id, run.id, [{ type: 'run_started', run }], revision);
  const db = getRawSqlite();
  // The host connection would already report SQLITE_BUSY here; the journal child
  // keeps waiting, so a contended commit must not fail the Run.
  const lockMs = HOST_BUSY_TIMEOUT_MS + 500;
  db.exec('BEGIN IMMEDIATE');
  const watchdog = setTimeout(() => { if (db.inTransaction) db.exec('ROLLBACK'); }, lockMs);
  try {
    await writer.append(session.id, run.id, [{ type: 'done', sessionId: session.id, runId: run.id }], revision);
  } finally {
    clearTimeout(watchdog);
    if (db.inTransaction) db.exec('ROLLBACK');
  }
  expect(runtimeJournal.read(session.id).map(row => row.chunk.type)).toEqual(['run_started', 'done']);
}, 20_000);
