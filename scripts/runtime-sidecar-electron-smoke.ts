import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication } from 'playwright-core';
import { encodeEnvelope, decodeEnvelope } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-protocol.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-electron-ws-'));
process.env.DATA_ROOT = path.join(root, 'data');
process.env.SYNAX_RUNTIME_SIDECAR_SUPERVISOR = '1';
const { startRustRuntimeSidecar, stopRustRuntimeSidecar } = await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
let desktop: ElectronApplication | undefined;
let runtime: Awaited<ReturnType<typeof startRustRuntimeSidecar>> = null;
try {
  runtime = await startRustRuntimeSidecar();
  assert(runtime);
  runtime.process.stderr?.on('data', chunk => console.error(String(chunk)));
  const entry = path.join(root, 'main.cjs');
  await writeFile(entry, `
    const { app, BrowserWindow, protocol } = require('electron');
    protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
    app.whenReady().then(() => {
      protocol.handle('app', () => new Response('<title>Native WebSocket probe</title><h1>Native WebSocket probe</h1>', { headers: { 'Content-Type': 'text/html' } }));
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      window.loadURL('app://synax/index.html');
    });
  `);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await _electron.launch({ args: [entry, `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await desktop.firstWindow();
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  const versions = await desktop.evaluate(() => ({ ...process.versions, websocket: typeof WebSocket }));
  const health = await page.evaluate(async ({ port, token }) => {
    if (typeof WebSocket !== 'function') throw new Error('Native WebSocket unavailable');
    return await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/runtime`);
      socket.binaryType = 'arraybuffer';
      const trace: string[] = [];
      socket.onclose = event => trace.push(`close:${event.code}:${event.reason}`);
      const timer = setTimeout(() => { socket.close(); reject(new Error(`WebSocket health timeout: ${trace.join(';')}`)); }, 10_000);
      socket.onopen = () => { trace.push('open'); socket.send(JSON.stringify({ type: 'hello', token })); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); };
      socket.onmessage = event => {
        const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        trace.push(text);
        const message = JSON.parse(text);
        if (message.type === 'ready') socket.send(JSON.stringify({ type: 'health' }));
        else { clearTimeout(timer); socket.close(); resolve(JSON.stringify(message)); }
      };
    });
  }, { port: runtime.port, token: runtime.token });
  assert.deepEqual(JSON.parse(health), { type: 'health', ok: true, protocol: 'synax.runtime.v2' });
  const base = { requestId: '', sessionId: '', epoch: 0, revision: 0 };
  const binaryReply = await page.evaluate(async ({ port, hello, health }) => {
    return await new Promise<number[]>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/runtime`);
      socket.binaryType = 'arraybuffer';
      let ready = false;
      const timer = setTimeout(() => { socket.close(); reject(new Error('Protobuf timeout')); }, 10_000);
      socket.onopen = () => socket.send(new Uint8Array(hello));
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Protobuf connection failed')); };
      socket.onmessage = event => {
        if (!ready) { ready = true; socket.send(new Uint8Array(health)); }
        else { clearTimeout(timer); socket.close(); resolve(Array.from(new Uint8Array(event.data))); }
      };
    });
  }, {
    port: runtime.port,
    hello: Array.from(encodeEnvelope({ ...base, body: { type: 'hello', token: runtime.token } })),
    health: Array.from(encodeEnvelope({ ...base, requestId: 'binary-health', body: { type: 'health' } })),
  });
  const decoded = decodeEnvelope(new Uint8Array(binaryReply));
  assert.equal(decoded.requestId, 'binary-health');
  assert.deepEqual(decoded.body, { type: 'health_response', ok: true, protocol: 'synax.runtime.v2' });
  assert.equal(versions.websocket, 'function', 'Electron main must expose native WebSocket too');
  console.log(JSON.stringify({ electron: versions.electron, chromium: versions.chrome, node: versions.node, rendererToRust: 'passed', mainNativeWebSocket: 'passed' }));
} finally {
  await desktop?.close();
  await stopRustRuntimeSidecar(runtime);
  await rm(root, { recursive: true, force: true });
}
