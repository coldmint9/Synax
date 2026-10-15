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

  const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/runtime`);
  const messages = [];
  const decode = async value => JSON.parse(new TextDecoder().decode(await value.arrayBuffer()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket health timed out')), 5_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token: 'smoke-token' })));
    ws.addEventListener('message', async event => {
      try {
        messages.push(await decode(event.data));
        if (messages.at(-1)?.type === 'ready') ws.send(JSON.stringify({ type: 'health' }));
        if (messages.at(-1)?.type === 'health') {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      } catch (error) { reject(error); }
    });
    ws.addEventListener('error', reject);
  });
  if (messages[0]?.type !== 'ready' || messages[1]?.type !== 'health' || messages[1]?.ok !== true)
    throw new Error(`unexpected WebSocket messages: ${JSON.stringify(messages)}`);

  const socket = createConnection(socketPath);
  const readFrame = () => new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32BE(0);
      if (buffer.length < 4 + size) return;
      socket.off('data', onData);
      resolve(JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')));
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  const sendFrame = payload => {
    const body = Buffer.from(JSON.stringify(payload));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    socket.write(Buffer.concat([header, body]));
  };
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  sendFrame({ type: 'hello', token: 'smoke-token' });
  const unixReady = await readFrame();
  if (unixReady.type !== 'ready' || unixReady.transport !== 'unix') throw new Error(JSON.stringify(unixReady));
  sendFrame({ type: 'health' });
  const unixHealth = await readFrame();
  if (unixHealth.type !== 'health' || unixHealth.ok !== true) throw new Error(JSON.stringify(unixHealth));
  sendFrame({ type: 'shutdown' });
  const shutdown = await readFrame();
  if (shutdown.type !== 'ack' || shutdown.request !== 'shutdown') throw new Error(JSON.stringify(shutdown));
  socket.destroy();

  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    setTimeout(() => reject(new Error('sidecar shutdown timed out')), 5_000);
  });
  console.log('runtime sidecar smoke passed');
} finally {
  cleanup();
}
