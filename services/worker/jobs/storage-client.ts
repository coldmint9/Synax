import net from 'node:net';
import { workerData, type MessagePort } from 'node:worker_threads';
import { frame, receiveFrames, type OwnerReply, type OwnerRequest } from '../../local-node/infrastructure/database/owner-protocol.js';

const { endpoint, port, signal } = workerData as { endpoint: string; port: MessagePort; signal: SharedArrayBuffer };
const state = new Int32Array(signal);
const socket = net.createConnection(endpoint);
let waiting = false;
let failure: Error | undefined;
function reply(message: OwnerReply): void {
  if (!waiting) return;
  waiting = false;
  port.postMessage(message);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
}
function fail(error: Error): void {
  failure = error;
  reply({ inTransaction: false, error: { name: 'StorageConnectionError', message: error.message, code: 'STORAGE_CONNECTION_LOST' } });
}
receiveFrames(socket, value => reply(value as OwnerReply));
socket.on('error', fail);
socket.on('close', () => fail(new Error('Storage owner disconnected; the last commit may have completed.')));
port.on('message', (request: OwnerRequest) => {
  waiting = true;
  if (failure) { fail(failure); return; }
  try { socket.write(frame(request)); } catch (error) { fail(error as Error); }
});
port.on('close', () => socket.destroy());
