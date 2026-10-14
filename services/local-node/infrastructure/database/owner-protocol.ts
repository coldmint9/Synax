import { serialize, deserialize } from 'node:v8';
import type { Socket } from 'node:net';
import type { RuntimeExecutionContext } from '../runtime/execution-context.js';

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export interface OwnerRequest {
  token: string;
  id?: string;
  sessionId?: string;
  requestId?: string;
  events?: import('../storage/session-log.js').LogEvent[];
  after?: number;
  limit?: number;
  operation: 'exec' | 'get' | 'all' | 'run' | 'iterate' | 'property' | 'close' | 'logAppend' | 'logRead' | 'logCursor' | 'logStatus' | 'queryResult';
  sql?: string;
  args?: unknown[];
  property?: string;
  cursor?: string;
  context?: RuntimeExecutionContext | null;
  hostId?: string;
}
export interface OwnerReply {
  id?: string;
  result?: unknown;
  inTransaction: boolean;
  error?: { name: string; message: string; code?: string; stack?: string };
}
export function frame(value: unknown): Buffer {
  const body = serialize(value);
  if (body.length > MAX_FRAME_BYTES) throw new Error('Storage response exceeds the bounded IPC budget; use paged reads.');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export function receiveFrames(socket: Socket, receive: (value: unknown) => void): void {
  let pending: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    try {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(0);
        if (size > MAX_FRAME_BYTES) throw new Error('Storage IPC frame too large.');
        if (pending.length < size + 4) break;
        const body = pending.subarray(4, size + 4);
        pending = pending.subarray(size + 4);
        receive(deserialize(body));
      }
    } catch (error) { socket.destroy(error as Error); }
  });
}
