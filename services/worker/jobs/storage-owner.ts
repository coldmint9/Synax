import NativeDatabase from 'libsql';
import net, { type Socket } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { SessionLog } from '../../local-node/infrastructure/storage/session-log.js';
import { randomUUID } from 'node:crypto';
import { workerData, type MessagePort } from 'node:worker_threads';
import { frame, receiveFrames, type OwnerRequest, type OwnerReply } from '../../local-node/infrastructure/database/owner-protocol.js';
import { runWithExecutionContext, withoutExecutionContext } from '../../local-node/infrastructure/runtime/execution-context.js';
import { runToCompletion } from '../../local-node/infrastructure/database/statement-lifecycle.js';

const { root, token, endpoint, port, signal } = workerData as {
  root: string; token: string; endpoint: string; port: MessagePort; signal: SharedArrayBuffer;
};
process.env.DATA_ROOT = root;
process.env.SYNAX_STORAGE_OWNER_PROCESS = '1';
delete process.env.SYNAX_AGENT_SESSION_CHILD;
const state = new Int32Array(signal);
function ready(error?: string): void {
  port.postMessage({ error });
  Atomics.store(state, 0, 1); Atomics.notify(state, 0); port.close();
}
async function main(): Promise<void> {
try {
  // Import only after setting this worker's environment: it owns the sole connection.
  const { getRawSqlite, assertRuntimeExecutionCurrent } = await import('../../local-node/infrastructure/database/index.js');
  const db = getRawSqlite();
  const log = new SessionLog(path.join(root, "session-logs"), {
    replayRetention: 1024,
    syncMode: process.env.SYNAX_REPLAY_FULL_FSYNC === "1" ? "full" : "data",
  });
  let transactionOwner: Socket | undefined;
  let transactionDeadline: NodeJS.Timeout | undefined;
  const queue: Array<{ socket: Socket; request: OwnerRequest }> = [];
  const cursors = new Map<string, { socket: Socket; iterator: Iterator<unknown>; database?: NativeDatabase.Database }>();
  function closeCursors(socket: Socket): void {
    for (const [id, cursor] of cursors) if (cursor.socket === socket) {
      cursor.iterator.return?.(); cursor.database?.close(); cursors.delete(id);
    }
  }
  function release(socket: Socket): void {
    closeCursors(socket);
    if (transactionOwner !== socket) return;
    if (transactionDeadline) clearTimeout(transactionDeadline);
    transactionDeadline = undefined;
    if (db.inTransaction) db.exec('ROLLBACK');
    transactionOwner = undefined;
  }
  function execute(socket: Socket, request: OwnerRequest): void {
    let reply: OwnerReply;
    try {
      const invoke = () => {
        if (request.operation === 'close') { release(socket); return; }
        if (request.operation === 'property') {
          const cursor = request.cursor && cursors.get(request.cursor);
          if (cursor && cursor.socket === socket) { cursor.iterator.return?.(); cursor.database?.close(); cursors.delete(request.cursor!); }
          return;
        }
        if (request.hostId) {
          const host = db.prepare('SELECT host_id FROM runtime_host_lock WHERE id=1').get() as { host_id: string } | undefined;
          if (host?.host_id !== request.hostId) throw Object.assign(new Error('Runtime host has been superseded.'), { code: 'EXECUTION_SUPERSEDED' });
        }
        if (request.operation.startsWith('log')) {
          if (!request.sessionId) throw new Error('Missing session identifier.');
          if (db.inTransaction) throw new Error('Log operations cannot be nested in a SQLite transaction.');
          if (request.operation === 'logAppend') {
            assertRuntimeExecutionCurrent();
            return log.append(request.sessionId, request.requestId!, request.events!);
          }
          if (request.operation === 'logRead') return log.read(request.sessionId, request.after, request.limit);
          if (request.operation === 'logCursor') return log.cursor(request.sessionId);
          if (request.operation === 'logStatus') return log.status(request.sessionId, request.requestId!);
        }
        if (!request.sql) throw new Error('Missing storage statement.');
        const input = request.args ?? [];
        // libsql treats a sole object as named bindings, including a Buffer.
        // Wrap a lone BLOB in a positional array to avoid a native unwrap panic.
        const args = input.length === 1 && (ArrayBuffer.isView(input[0]) || input[0] instanceof ArrayBuffer) ? [input] : input;
        if (request.operation === 'exec') { db.exec(request.sql); return; }
        if (request.operation === 'iterate') {
          // A transaction cannot commit while a statement on the writer
          // connection is still stepping. Materialize transactional iterators
          // so the statement is finalized before the response returns.
          if (db.inTransaction && !request.cursor) {
            const rows = db.prepare(request.sql).all(...args) as unknown[];
            return { rows: rows.map(row => structuredClone(row)) };
          }
          if (cursors.size >= 64 && !request.cursor) throw new Error('Too many storage cursors.');
          const id = request.cursor ?? randomUUID();
          let cursor = cursors.get(id);
          if (request.cursor && (!cursor || cursor.socket !== socket)) throw new Error('Storage cursor expired.');
          if (!cursor) {
            // A paged reader outside a transaction uses its own WAL snapshot.
            const reader = new NativeDatabase(path.join(root, 'context.db'), { readonly: true });
            try { cursor = { socket, database: reader, iterator: reader.prepare(request.sql).iterate(...args)[Symbol.iterator]() }; }
            catch (failure) { reader.close(); throw failure; }
            cursors.set(id, cursor);
          }
          const rows: unknown[] = [];
          for (let i = 0; i < 128; i++) {
            const next = cursor.iterator.next();
            if (next.done) { cursor.database?.close(); cursors.delete(id); return { rows }; }
            // Native BLOBs may borrow the reader connection's storage. Copy
            // before closing the last page, then serialize the owned values.
            rows.push(structuredClone(next.value));
          }
          return { rows, cursor: id };
        }
        const statement = db.prepare(request.sql);
        if (request.operation === 'queryResult') {
          const columns = statement.columns();
          let rows: unknown[][] = [], rowsAffected = 0, lastInsertRowid: bigint | undefined;
          if (statement.reader) rows = statement.raw(true).all(...args) as unknown[][];
          else { const result = runToCompletion(db, statement, args) as { changes: number; lastInsertRowid: number | bigint }; rowsAffected = result.changes; lastInsertRowid = BigInt(result.lastInsertRowid); }
          return { columns: columns.map(column => column.name), columnTypes: columns.map(column => column.type ?? ''), rows, rowsAffected, lastInsertRowid };
        }
        if (request.operation !== 'run' && request.operation !== 'get' && request.operation !== 'all') throw new Error('Unsupported storage operation.');
        if (request.operation === 'run') return runToCompletion(db, statement, args);
        if (request.operation === 'all') return statement.all(...args);
        if (!statement.reader) return statement.get(...args);
        let first: unknown;
        let seen = false;
        for (const row of statement.iterate(...args)) {
          if (!seen) { first = row; seen = true; }
        }
        return first;
      };
      const result = request.context === null
        ? withoutExecutionContext(invoke)
        : runWithExecutionContext(request.context, invoke);
      if (result instanceof Promise) {
        void result.then(value => {
          if (!socket.destroyed) socket.write(frame({ id: request.id, result: value, inTransaction: false }));
        }, failure => {
          if (!socket.destroyed) socket.write(frame({ id: request.id, inTransaction: false, error: { name: failure.name, message: failure.message, code: failure.code } }));
        }).catch(() => socket.destroy());
        return;
      }
      reply = { id: request.id, result, inTransaction: db.inTransaction };
    } catch (error) {
      const failure = error as Error & { code?: string };
      reply = { id: request.id, inTransaction: db.inTransaction, error: { name: failure.name, message: failure.message, code: failure.code } };
    }
    if (db.inTransaction && !transactionOwner) {
      transactionOwner = socket;
      // A disconnected or stalled client must not leave a permanent writer reservation.
      transactionDeadline = setTimeout(() => { release(socket); socket.destroy(); drain(); }, 60_000);
      transactionDeadline.unref();
    } else if (!db.inTransaction && transactionOwner === socket) {
      transactionOwner = undefined;
      if (transactionDeadline) clearTimeout(transactionDeadline);
      transactionDeadline = undefined;
    }
    try { socket.write(frame(reply)); } catch (error) {
      release(socket); socket.destroy(error as Error);
    }
  }
  function drain(): void {
    for (;;) {
      const index = transactionOwner ? queue.findIndex(entry => entry.socket === transactionOwner) : 0;
      if (index < 0 || !queue.length) return;
      const [entry] = queue.splice(index, 1);
      if (!entry.socket.destroyed) execute(entry.socket, entry.request);
    }
  }
  const server = net.createServer(socket => {
    receiveFrames(socket, value => {
      const request = value as OwnerRequest;
      if (!request || request.token !== token) { socket.destroy(); return; }
      if (queue.length >= 512) { socket.destroy(new Error('Storage admission queue is full.')); return; }
      queue.push({ socket, request }); drain();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      release(socket);
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].socket === socket) queue.splice(i, 1);
      drain();
    });
  });
  server.on('error', error => ready(error.message));
  if (process.platform !== 'win32' && fs.existsSync(endpoint)) fs.unlinkSync(endpoint);
  server.listen(endpoint, () => {
    if (process.platform !== 'win32') fs.chmodSync(endpoint, 0o600);
    ready();
  });
} catch (error) { ready((error as Error).message); }

}
void main();
