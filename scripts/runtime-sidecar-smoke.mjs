import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'synax-runtime-sidecar-smoke-'));
const socketPath = join(root, 'runtime.sock');
const binary = join(process.cwd(), 'runtime-sidecar', 'target', 'release', 'synax-runtime-sidecar');
const child = spawn(binary, [], {
  env: {
    ...process.env,
    SYNAX_RUNTIME_SIDECAR_SOCKET: socketPath,
    SYNAX_RUNTIME_SIDECAR_TOKEN: 'smoke-token',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const cleanup = () => {
  if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
  try { unlinkSync(socketPath); } catch {}
  rmSync(root, { recursive: true, force: true });
};
process.once('exit', cleanup);

const concat = (...parts) => Buffer.concat(parts.filter(Boolean));
const varint = value => {
  const bytes = [];
  let current = BigInt(value);
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Buffer.from(bytes);
};
const fieldBytes = (field, bytes) => concat(varint((field << 3) | 2), varint(bytes.length), bytes);
const fieldString = (field, value) => fieldBytes(field, Buffer.from(value));
const fieldUint = (field, value) => concat(varint(field << 3), varint(value));
const envelope = ({ requestId = '', sessionId = '', epoch = 0, revision = 0, bodyField, body = Buffer.alloc(0) }) => concat(
  requestId && fieldString(1, requestId),
  sessionId && fieldString(2, sessionId),
  epoch && fieldUint(3, epoch),
  revision && fieldUint(4, revision),
  fieldBytes(bodyField, body),
);
const hello = token => envelope({ bodyField: 10, body: fieldString(1, token) });
const health = () => envelope({ bodyField: 11 });
const shutdown = () => envelope({ bodyField: 12 });
const subscribe = ({ requestId, sessionId, after }) => envelope({
  requestId,
  sessionId,
  bodyField: 18,
  body: fieldUint(1, after),
});
const admitRun = ({ requestId, sessionId, epoch, revision, bodyHash, runId }) => envelope({
  requestId,
  sessionId,
  epoch,
  revision,
  bodyField: 14,
  body: concat(fieldString(1, bodyHash), fieldString(2, runId)),
});
const appendStream = ({ requestId, sessionId, epoch, revision, runId, producerId, producerSequence, kind, payload }) => envelope({
  requestId,
  sessionId,
  epoch,
  revision,
  bodyField: 15,
  body: concat(
    fieldString(1, runId),
    fieldString(2, producerId),
    fieldUint(3, producerSequence),
    fieldBytes(4, concat(fieldString(1, kind), fieldBytes(2, Buffer.from(payload)))),
  ),
});
const snapshot = ({ requestId, sessionId, epoch, revision }) => envelope({
  requestId,
  sessionId,
  epoch,
  revision,
  bodyField: 16,
});
const replay = ({ requestId, sessionId, after }) => envelope({
  requestId,
  sessionId,
  bodyField: 17,
  body: fieldUint(1, after),
});

const readVarint = (bytes, state) => {
  let result = 0n;
  let shift = 0n;
  while (state.offset < bytes.length) {
    const byte = bytes[state.offset++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
  }
  throw new Error('truncated protobuf varint');
};
const hasField = (bytes, wanted) => {
  const state = { offset: 0 };
  while (state.offset < bytes.length) {
    const key = Number(readVarint(bytes, state));
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      readVarint(bytes, state);
    } else if (wire === 2) {
      const length = Number(readVarint(bytes, state));
      const start = state.offset;
      state.offset += length;
      if (field === wanted) return bytes.subarray(start, state.offset);
    } else if (wire === 1) {
      state.offset += 8;
    } else if (wire === 5) {
      state.offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return null;
};
const toBuffer = async value => {
  if (value instanceof Blob) return Buffer.from(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
};

function connectUnix() {
  const socket = createConnection(socketPath);
  let pending = Buffer.alloc(0);
  const readFrame = () => new Promise((resolve, reject) => {
    const onData = chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const size = pending.readUInt32BE(0);
      if (pending.length < 4 + size) return;
      const frame = pending.subarray(4, 4 + size);
      pending = pending.subarray(4 + size);
      socket.off('data', onData);
      resolve(frame);
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  const sendFrame = payload => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    socket.write(Buffer.concat([header, payload]));
  };
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return { socket, readFrame, sendFrame, connected };
}

async function connectWebSocket(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/runtime`);
  const messages = [];
  const waitFor = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket response timed out')), 5_000);
    const onMessage = async event => {
      try {
        const message = await toBuffer(event.data);
        messages.push(message);
        if (predicate(message)) {
          clearTimeout(timer);
          socket.removeEventListener('message', onMessage);
          resolve(message);
        }
      } catch (error) { reject(error); }
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', reject, { once: true });
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.send(hello('smoke-token'));
  await waitFor(message => Boolean(hasField(message, 19)));
  return { socket, messages, waitFor };
}

try {
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sidecar startup timed out')), 10_000);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(value => value.startsWith('SYNAX_RUNTIME_READY:'));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice('SYNAX_RUNTIME_READY:'.length)));
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`sidecar exited before READY (${code})`)));
  });

  const control = await connectWebSocket(ready.port);
  control.socket.send(health());
  await control.waitFor(message => Boolean(hasField(message, 20)));
  control.socket.close();
  console.log('websocket protobuf health passed');

  const subscription = await connectWebSocket(ready.port);
  subscription.socket.send(subscribe({ requestId: 'sub-1', sessionId: 'unix-session', after: 0 }));
  const snapshotResponse = await subscription.waitFor(message => Boolean(hasField(message, 25)));
  if (!hasField(snapshotResponse, 25)) throw new Error('subscription snapshot missing');

  const unix = connectUnix();
  await unix.connected;
  unix.sendFrame(hello('smoke-token'));
  if (!hasField(await unix.readFrame(), 19)) throw new Error('unix READY missing');
  unix.sendFrame(admitRun({ requestId: 'unix-req', sessionId: 'unix-session', epoch: 1, revision: 0, bodyHash: 'unix-body', runId: 'unix-run' }));
  if (!hasField(await unix.readFrame(), 24)) throw new Error('unix admission missing');
  unix.sendFrame(appendStream({ requestId: 'unix-append', sessionId: 'unix-session', epoch: 1, revision: 1, runId: 'unix-run', producerId: 'producer-1', producerSequence: 1, kind: 'message_delta', payload: 'hello' }));
  if (!hasField(await unix.readFrame(), 22)) throw new Error('unix append ack missing');
  const liveEvent = await subscription.waitFor(message => Boolean(hasField(message, 26)));
  if (!hasField(liveEvent, 26)) throw new Error('subscription live event missing');
  subscription.socket.close();

  unix.sendFrame(replay({ requestId: 'unix-replay', sessionId: 'unix-session', after: 0 }));
  if (!hasField(await unix.readFrame(), 26)) throw new Error('unix replay missing');
  unix.sendFrame(snapshot({ requestId: 'unix-snapshot', sessionId: 'unix-session', epoch: 1, revision: 1 }));
  if (!hasField(await unix.readFrame(), 25)) throw new Error('unix snapshot missing');
  unix.sendFrame(shutdown());
  if (!hasField(await unix.readFrame(), 22)) throw new Error('unix shutdown ack missing');
  unix.socket.destroy();

  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    setTimeout(() => reject(new Error('sidecar shutdown timed out')), 5_000);
  });
  console.log('unix protobuf command/replay/subscription smoke passed');
} finally {
  cleanup();
}
