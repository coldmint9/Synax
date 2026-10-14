import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { runtimeAsset } from '../runtime/runtime-paths.js';
import { currentStorageExecutionContext } from '../runtime/execution-context.js';
import type NativeDatabase from 'libsql';
import type { OwnerReply, OwnerRequest } from './owner-protocol.js';

const WAIT_MS = 30_000;
function launch(entry: string, data: unknown, transferList: MessagePort[] = []): Worker {
  const options = { workerData: data, transferList };
  // A source worker needs its own TypeScript loader; bundled workers run directly.
  const worker = entry.endsWith('.ts')
    ? new Worker(`require('tsx/esm/api').register(); require('tsx/cjs'); require(${JSON.stringify(entry)});`, { ...options, eval: true, execArgv: [] })
    : new Worker(entry, { ...options, execArgv: [] });
  worker.on('error', () => { /* Synchronous callers observe the bounded connection failure. */ });
  worker.unref();
  return worker;
}

let owner: Worker | undefined;
export function startStorageOwner(root: string): void {
  if (process.env.SYNAX_STORAGE_OWNER_ENDPOINT) return;
  const token = randomBytes(32).toString('hex');
  const key = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\synax-storage-${key}-${process.pid}`
    : path.join(os.tmpdir(), `synax-storage-${key}-${process.pid}.sock`);
  const { port1, port2 } = new MessageChannel();
  const signal = new SharedArrayBuffer(4);
  const state = new Int32Array(signal);
  const entry = runtimeAsset(import.meta.url, '../../../worker/jobs/storage-owner.ts', 'workers/storage-owner.cjs');
  owner = launch(entry, { root: path.resolve(root), token, endpoint, port: port2, signal }, [port2]);
  const outcome = Atomics.wait(state, 0, 0, WAIT_MS);
  const ready = receiveMessageOnPort(port1)?.message as { error?: string } | undefined;
  port1.close();
  if (outcome === 'timed-out' || !ready || ready.error) {
    void owner.terminate(); owner = undefined;
    throw new Error(ready?.error ?? 'Storage owner startup timed out.');
  }
  process.env.SYNAX_STORAGE_OWNER_ENDPOINT = endpoint;
  process.env.SYNAX_STORAGE_OWNER_TOKEN = token;
  process.env.SYNAX_STORAGE_OWNER_ROOT = path.resolve(root);
}
export function stopStorageOwner(): void {
  if (!owner) return;
  void owner.terminate(); owner = undefined;
  delete process.env.SYNAX_STORAGE_OWNER_ENDPOINT;
  delete process.env.SYNAX_STORAGE_OWNER_TOKEN;
  delete process.env.SYNAX_STORAGE_OWNER_ROOT;
}

export type OwnerConnection = NativeDatabase.Database & {
  executeStatement(sql: string, args: unknown[]): { columns: string[]; columnTypes: string[]; rows: unknown[][]; rowsAffected: number; lastInsertRowid: bigint | undefined };
};
export function connectStorageOwner(databasePath: string): OwnerConnection {
  const endpoint = process.env.SYNAX_STORAGE_OWNER_ENDPOINT;
  const token = process.env.SYNAX_STORAGE_OWNER_TOKEN;
  if (!endpoint || !token || path.basename(databasePath) !== "context.db" || path.dirname(databasePath) !== process.env.SYNAX_STORAGE_OWNER_ROOT)
    throw new Error('Storage owner scope does not match the database.');
  const { port1, port2 } = new MessageChannel();
  const signal = new SharedArrayBuffer(4);
  const state = new Int32Array(signal);
  const entry = runtimeAsset(import.meta.url, '../../../worker/jobs/storage-client.ts', 'workers/storage-client.cjs');
  const worker = launch(entry, { endpoint, port: port2, signal }, [port2]);
  port1.unref();
  let open = true, inTransaction = false;
  function request(input: Omit<OwnerRequest, 'token' | 'context' | 'hostId'>): unknown {
    if (!open) throw new Error('Storage connection is closed.');
    Atomics.store(state, 0, 0);
    port1.postMessage({ ...input, token, context: currentStorageExecutionContext(), hostId: process.env.SYNAX_RUNTIME_HOST_ID });
    if (Atomics.wait(state, 0, 0, WAIT_MS) === 'timed-out') {
      open = false; port1.close(); void worker.terminate();
      throw Object.assign(new Error('Storage acknowledgement timed out; query committed state before retrying.'), { code: 'STORAGE_COMMIT_UNKNOWN' });
    }
    const message = receiveMessageOnPort(port1)?.message as OwnerReply | undefined;
    if (!message) throw new Error('Storage response is missing.');
    inTransaction = message.inTransaction;
    if (message.error) {
      const error = Object.assign(new Error(message.error.message), { name: message.error.name, code: message.error.code });
      if (message.error.code === 'STORAGE_CONNECTION_LOST') { open = false; port1.close(); void worker.terminate(); }
      throw error;
    }
    return message.result;
  }
  const database = {
    get open() { return open; },
    get inTransaction() { return inTransaction; },
    name: databasePath,
    executeStatement(sql: string, args: unknown[]) { return request({ operation: 'queryResult', sql, args }); },
    exec(sql: string) { request({ operation: 'exec', sql }); return database; },
    prepare(sql: string) {
      return {
        source: sql,
        run: (...args: unknown[]) => request({ operation: 'run', sql, args }),
        get: (...args: unknown[]) => request({ operation: 'get', sql, args }),
        all: (...args: unknown[]) => request({ operation: 'all', sql, args }),
        *iterate(...args: unknown[]): Generator<unknown> {
          let cursor: string | undefined;
          try {
            do {
              const page = request({ operation: 'iterate', sql, args, cursor }) as { rows: unknown[]; cursor?: string };
              cursor = page.cursor;
              yield* page.rows;
            } while (cursor);
          } finally {
            if (cursor && open) request({ operation: 'property', property: 'closeCursor', cursor });
          }
        },
      };
    },
    close() {
      if (!open) return;
      try { request({ operation: 'close' }); } finally { open = false; port1.close(); void worker.terminate(); }
    },
  };
  return database as unknown as OwnerConnection;
}
