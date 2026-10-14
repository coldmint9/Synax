import net, { type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { currentStorageExecutionContext } from '../runtime/execution-context.js';
import { frame, receiveFrames, type OwnerRequest, type OwnerReply } from '../database/owner-protocol.js';
import type { LogEvent, LogReceipt, CommittedEvent } from './session-log.js';

let socket: Socket | undefined;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
function connect(): Socket {
  if (socket && !socket.destroyed) return socket;
  const endpoint = process.env.SYNAX_STORAGE_OWNER_ENDPOINT;
  if (!endpoint) throw new Error('Session log requires the storage owner.');
  const active = socket = net.createConnection(endpoint);
  active.unref();
  const fail = (error: Error) => {
    if (socket !== active) return;
    socket = undefined;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  active.on('error', fail);
  active.on('close', () => fail(Object.assign(new Error('Log connection closed; query the request ID before retrying.'), { code: 'LOG_COMMIT_UNKNOWN' })));
  receiveFrames(active, value => {
    const reply = value as OwnerReply;
    const entry = reply.id && pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id!); clearTimeout(entry.timer);
    if (!pending.size) active.unref();
    if (reply.error) entry.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name, code: reply.error.code }));
    else entry.resolve(reply.result);
  });
  return active;
}
async function request<T>(input: Omit<OwnerRequest, 'token'>): Promise<T> {
  const active = connect();
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      if (!pending.size) active.unref();
      reject(Object.assign(new Error('Log acknowledgement timed out; query the request ID before retrying.'), { code: 'LOG_COMMIT_UNKNOWN' }));
    }, 30_000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    active.ref();
    try {
      active.write(frame({ ...input, id, token: process.env.SYNAX_STORAGE_OWNER_TOKEN, context: currentStorageExecutionContext(), hostId: process.env.SYNAX_RUNTIME_HOST_ID }));
    } catch (error) { pending.delete(id); clearTimeout(timer); if (!pending.size) active.unref(); reject(error); }
  });
}
export const sessionLogClient = {
  append: (sessionId: string, requestId: string, events: LogEvent[]) => request<LogReceipt>({ operation: 'logAppend', sessionId, requestId, events }),
  read: (sessionId: string, after = 0, limit = 256) => request<CommittedEvent[]>({ operation: 'logRead', sessionId, after, limit }),
  cursor: (sessionId: string) => request<number>({ operation: 'logCursor', sessionId }),
  status: (sessionId: string, requestId: string) => request<LogReceipt | undefined>({ operation: 'logStatus', sessionId, requestId }),
  async close() {
    // Callers must drain their work before closing the shared channel.
    if (pending.size) throw new Error('Cannot close session log with pending commits.');
    socket?.destroy(); socket = undefined;
  },
};
