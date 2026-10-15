import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'synax-runtime-sidecar-crash-'));
const hotPath = join(root, 'runtime-hot');
const binary = join(process.cwd(), 'runtime-sidecar', 'target', 'release', 'synax-runtime-sidecar');
const token = 'crash-smoke-token';

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
const hello = () => envelope({ bodyField: 10, body: fieldString(1, token) });
const shutdown = () => envelope({ bodyField: 12 });
const admit = () => envelope({
  requestId: 'crash-request',
  sessionId: 'crash-session',
  epoch: 1,
  revision: 0,
  bodyField: 14,
  body: concat(fieldString(1, 'crash-body'), fieldString(2, 'crash-run')),
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
  throw new Error('truncated protobuf');
};
const field = (bytes, wanted) => {
  const state = { offset: 0 };
  while (state.offset < bytes.length) {
    const key = Number(readVarint(bytes, state));
    const number = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      const value = readVarint(bytes, state);
      if (number === wanted) return value;
    } else if (wire === 2) {
      const length = Number(readVarint(bytes, state));
      const start = state.offset;
      state.offset += length;
      if (number === wanted) return bytes.subarray(start, state.offset);
    } else if (wire === 1) state.offset += 8;
    else if (wire === 5) state.offset += 4;
    else throw new Error(`unsupported wire ${wire}`);
  }
  return undefined;
};

function startSidecar(socketPath, abortAfterCommit) {
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      SYNAX_RUNTIME_SIDECAR_SOCKET: socketPath,
      SYNAX_RUNTIME_SIDECAR_TOKEN: token,
      SYNAX_RUNTIME_HOT_PATH: hotPath,
      ...(abortAfterCommit ? { SYNAX_RUNTIME_HOT_ABORT_AFTER_COMMIT: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('crash smoke READY timeout')), 10_000);
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
  return { child, ready };
}

async function connectAndFrame(socketPath, body) {
  const socket = createConnection(socketPath);
  let pending = Buffer.alloc(0);
  const readFrame = () => new Promise((resolve, reject) => {
    const onData = chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const size = pending.readUInt32BE(0);
      if (pending.length < size + 4) return;
      const frame = pending.subarray(4, size + 4);
      pending = pending.subarray(size + 4);
      socket.off('data', onData);
      resolve(frame);
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  const sendFrame = value => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(value.length);
    socket.write(Buffer.concat([header, value]));
  };
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  sendFrame(hello());
  await readFrame();
  sendFrame(body);
  return { socket, readFrame, sendFrame };
}

const sockets = [];
try {
  const firstSocket = join(root, 'crash.sock');
  const first = startSidecar(firstSocket, true);
  await first.ready;
  const connection = await connectAndFrame(firstSocket, admit());
  await new Promise(resolve => {
    connection.socket.once('close', resolve);
    connection.socket.destroy();
  });
  await new Promise((resolve, reject) => {
    first.child.once('exit', resolve);
    setTimeout(() => reject(new Error('crashing sidecar did not exit')), 5_000);
  });

  const secondSocket = join(root, 'recovered.sock');
  const second = startSidecar(secondSocket, false);
  await second.ready;
  const recovered = await connectAndFrame(secondSocket, admit());
  const response = await recovered.readFrame();
  const admissionBody = field(response, 24);
  if (!(admissionBody instanceof Uint8Array)) throw new Error('recovery response was not run admission');
  if (Number(field(admissionBody, 4)) !== 1) throw new Error('recovery did not return reused receipt');
  recovered.sendFrame(shutdown());
  await recovered.readFrame();
  recovered.socket.destroy();
  await new Promise((resolve, reject) => {
    second.child.once('exit', resolve);
    setTimeout(() => reject(new Error('recovery sidecar did not stop')), 5_000);
  });
  console.log('runtime sidecar crash receipt smoke passed');
} finally {
  for (const socket of sockets) socket.destroy?.();
  rmSync(root, { recursive: true, force: true });
}
