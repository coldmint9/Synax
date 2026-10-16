import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron, type ElectronApplication } from 'playwright-core';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';
import { encodeEnvelope, type SidecarBody } from '../packages/runtime-protocol/wire.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-ui-'));
Object.assign(process.env, { DATA_ROOT: root, SYNAX_RUNTIME_SIDECAR_SUPERVISOR: '1' });
const { startRustRuntimeSidecar, stopRustRuntimeSidecar } = await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
const runtime = await startRustRuntimeSidecar();
assert(runtime);
let rustErrors = "";
runtime.process.stderr?.on("data", chunk => { rustErrors += String(chunk); });
const control = new RuntimeSidecarClient({ socketPath: runtime.socketPath, token: runtime.token });
let desktop: ElectronApplication | undefined;
try {
  const sessionId = 'ui-session';
  await control.seedUi(sessionId, new TextEncoder().encode(JSON.stringify({ id: sessionId, projectId: 'test', status: 'queued', updatedAt: new Date().toISOString() })));
  await control.admitRun({ sessionId, requestId: 'start', bodyHash: 'body', runId: 'r', epoch: 1, revision: 0 });
  const state = { status: 'running', activeRunId: 'r', pendingResumeToken: null, blockedReason: null, updatedAt: new Date().toISOString() };
  let producerSequence = 0;
  async function append(count: number) {
    await control.appendStream({ sessionId, runId: 'r', producerId: 'p', producerSequence: ++producerSequence, epoch: 1, revision: 1,
      events: Array.from({ length: count }, (_, index) => {
        const chunk = producerSequence === 1 && index === 0
          ? { type: 'step_started', step: { id: 'step', sessionId, runId: 'r', index: 1 } }
          : { type: 'message_delta', stepId: 'step', delta: 'delta' };
        return { kind: chunk.type, payload: new TextEncoder().encode(JSON.stringify({ schema: 1, state, chunk })) };
      }),
    });
  }
  for (let batch = 0; batch < 3; batch++) await append(200);
  const entry = path.join(root, 'main.cjs');
  await writeFile(entry, `
    const { app, BrowserWindow, protocol } = require('electron');
    protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
    app.whenReady().then(() => {
      protocol.handle('app', () => new Response('<title>Rust session transport</title><h1>Rust session transport</h1><pre id="status">Connecting</pre>', {headers:{'Content-Type':'text/html'}}));
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      win.loadURL('app://synax/index.html');
    });
  `);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  desktop = await _electron.launch({ args: [entry, `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await desktop.firstWindow();
  await page.waitForURL('app://synax/index.html');
  await page.waitForLoadState('domcontentloaded');
  // tsx preserves names of inline callbacks with a helper outside evaluate's closure.
  // The app bundle has its own helpers; this shim is only for the test callbacks.
  await page.addScriptTag({ content: 'globalThis.__name = (fn) => fn;' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const bundle = await build({ entryPoints: ['client/src/adapters/transport/rustRuntimeConnection.ts'], bundle: true, write: false, format: 'iife', globalName: 'RustTransport', platform: 'browser' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  let tickets = 0;
  await page.exposeFunction('getTicket', async (snapshot: boolean) => {
    tickets++;
    const ticket = await control.issueTicket(sessionId, 'window1');
    return { transport: 'rust', ticket: { url: `ws://127.0.0.1:${runtime.port}/runtime`, token: ticket.token, expiresAtMs: ticket.expiresAtMs,
      sessionId, clientId: 'window1', protocol: 'synax.runtime.v2' } };
  });
  await page.evaluate(() => {
    const w = window as any;
    w.records = []; w.states = []; w.snapshots = [];
    w.connection = new w.RustTransport.RustRuntimeConnection({ sessionId: 'ui-session', bootstrap: (needsSnapshot: boolean) => w.getTicket(needsSnapshot),
      snapshot: (snapshot: unknown) => w.snapshots.push(snapshot), record: (record: { sequence: number }) => { w.records.push(record.sequence); document.querySelector('#status')!.textContent = `Received ${w.records.length} events`; },
      state: (state: string) => w.states.push(state), fallback: () => { throw new Error('unexpected Node fallback'); },
    });
    w.connection.start();
  });
  await page.waitForFunction(() => (window as any).states.includes('connected'), {}, { timeout: 15_000 });
  assert.equal(await page.evaluate(() => (window as any).snapshots[0].cursor), 600);
  assert.equal(await page.evaluate(() => (window as any).snapshots[0].liveChunks[1].delta), 'delta'.repeat(599));
  await page.evaluate(() => (window as any).connection.wake());
  await append(25);
  await page.waitForFunction(() => (window as any).records.length === 25, { }, { timeout: 15_000 });
  assert.deepEqual(await page.evaluate(() => (window as any).records), Array.from({ length: 25 }, (_, i) => i + 601));
  assert(tickets >= 2, 'reconnect requires a fresh one-use ticket');
  const originalProcess = runtime.process;
  const exited = once(originalProcess, 'exit');
  originalProcess.kill('SIGKILL'); await exited;
  await runtime.waitUntilReady();
  await append(25);
  await page.waitForFunction(() => (window as any).records.length === 50, {}, { timeout: 15_000 });
  assert.deepEqual(await page.evaluate(() => (window as any).records), Array.from({ length: 50 }, (_, i) => i + 601));
  assert(runtime.generation >= 2 && tickets >= 3, 'process restart must renew discovery and ticket');
  await page.evaluate(() => (window as any).connection.close());

  // Use a second native socket without the adapter: lack of ACK must stop at 64 events.
  const grant = await control.issueTicket(sessionId, 'slow-window');
  const envelope = (body: SidecarBody, requestId = 'slow', id = sessionId) => Array.from(encodeEnvelope({ requestId, sessionId: id, epoch: 0, revision: 0, body }));
  const codec = await build({ entryPoints: ['packages/runtime-protocol/wire.ts'], bundle: true, write: false, format: 'iife', globalName: 'Wire', platform: 'browser' });
  await page.addScriptTag({ content: codec.outputFiles[0].text });
  await page.evaluate(({ port, hello, subscribe }) => {
    const w = window as any;
    w.slowEvents = 0; w.slowErrors = [];
    const socket = w.slow = new WebSocket(`ws://127.0.0.1:${port}/runtime`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => socket.send(new Uint8Array(hello));
    socket.onmessage = event => {
      const body = w.Wire.decodeEnvelope(new Uint8Array(event.data)).body;
      if (body.type === 'ready') socket.send(new Uint8Array(subscribe));
      if (body.type === 'event_batch') w.slowEvents += body.events.length;
      if (body.type === 'error') w.slowErrors.push(body.code);
    };
  }, { port: runtime.port, hello: envelope({ type: 'hello', token: grant.token, clientId: 'slow-window' }), subscribe: envelope({ type: 'subscribe', after: 0 }) });
  await page.waitForFunction(() => (window as any).slowEvents === 64);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await page.evaluate(() => (window as any).slowEvents), 64);
  await page.evaluate(bytes => (window as any).slow.send(new Uint8Array(bytes)), envelope({ type: 'credit', throughSequence: 99999 }));
  await page.waitForFunction(() => (window as any).slowErrors.includes('INVALID_CREDIT'));

  const overflowGrant = await control.issueTicket(sessionId, 'overflow-window');
  await page.evaluate(({ port, hello, subscribe }) => {
    const w = window as any;
    w.overflow = { count: 0, last: 650, ready: false, autoAck: false, errors: [] };
    const socket = w.overflowSocket = new WebSocket(`ws://127.0.0.1:${port}/runtime`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => socket.send(new Uint8Array(hello));
    socket.onmessage = event => {
      const body = w.Wire.decodeEnvelope(new Uint8Array(event.data)).body;
      if (body.type === 'ready') socket.send(new Uint8Array(subscribe));
      if (body.type === 'snapshot_response') w.overflow.ready = true;
      if (body.type === 'event_batch') {
        w.overflow.count += body.events.length;
        w.overflow.last = body.events.at(-1).sequence;
        if (w.overflow.autoAck) socket.send(w.Wire.encodeEnvelope({ requestId: 'overflow', sessionId: 'ui-session', epoch: 0, revision: 0,
          body: { type: 'credit', throughSequence: w.overflow.last } }));
      }
      if (body.type === 'error') w.overflow.errors.push(body.code);
    };
  }, { port: runtime.port, hello: envelope({ type: 'hello', token: overflowGrant.token, clientId: 'overflow-window' }),
    subscribe: envelope({ type: 'subscribe', after: 650 }, 'overflow') });
  await page.waitForFunction(() => (window as any).overflow.ready);
  await append(200); // More than send window + live mailbox; no ACKs yet.
  await page.waitForFunction(() => (window as any).overflow.count === 64);
  await page.evaluate(() => {
    const w = window as any;
    w.overflow.autoAck = true;
    w.overflowSocket.send(w.Wire.encodeEnvelope({ requestId: 'overflow', sessionId: 'ui-session', epoch: 0, revision: 0,
      body: { type: 'credit', throughSequence: w.overflow.last } }));
  });
  try { await page.waitForFunction(() => (window as any).overflow.errors.includes('RESYNC_REQUIRED'), {}, { timeout: 5_000 }); }
  catch (error) { console.error('Overflow diagnostics', await page.evaluate(() => ({ state: (window as any).overflow, socket: (window as any).overflowSocket.readyState })), rustErrors, errors); throw error; }
  assert.equal((await control.health()).ok, true, 'a slow UI cannot block the control socket');

  // A UI grant cannot read another session, mutate runtime state, or be reused.
  const limited = await control.issueTicket(sessionId, 'limited');
  const codes = await page.evaluate(async ({ port, hello, forbidden }) => {
    const w = window as any;
    const connect = () => new Promise<string[]>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/runtime`); socket.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { socket.close(); reject(new Error('scope probe timeout')); }, 5_000);
      const codes: string[] = [];
      socket.onopen = () => socket.send(new Uint8Array(hello));
      socket.onmessage = event => {
        const body = w.Wire.decodeEnvelope(new Uint8Array(event.data)).body;
        if (body.type === 'ready') for (const bytes of forbidden) socket.send(new Uint8Array(bytes));
        if (body.type === 'error') {
          codes.push(body.code);
          if (codes.length === forbidden.length || body.code === 'UNAUTHENTICATED') { clearTimeout(timer); socket.close(); resolve(codes); }
        }
      };
    });
    return [await connect(), await connect()];
  }, { port: runtime.port, hello: envelope({ type: 'hello', token: limited.token, clientId: 'limited' }),
    forbidden: [envelope({ type: 'snapshot' }, 'other', 'other-session'), envelope({ type: 'ui_snapshot' }, 'other-ui', 'other-session'), envelope({ type: 'seed_ui', sessionJson: new TextEncoder().encode('{}') }, 'seed'), envelope({ type: 'queue_mutation', operation: 'clear_force', payload: new TextEncoder().encode('null') }, 'queue-write'), envelope({ type: 'shutdown' }, 'shutdown')] });
  assert.deepEqual(codes, [['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'], ['UNAUTHENTICATED']]);
  // A newly attached real renderer must observe command-driven completion without reconnecting.
  await page.evaluate(() => {
    const w = window as any;
    w.finalSnapshots = []; w.finalEvents = []; w.finalStates = [];
    w.finalConnection = new w.RustTransport.RustRuntimeConnection({ sessionId: 'ui-session', bootstrap: (needsSnapshot: boolean) => w.getTicket(needsSnapshot),
      snapshot: (snapshot: unknown) => w.finalSnapshots.push(snapshot),
      record: (record: any) => { w.finalEvents.push(record); document.querySelector('#status')!.textContent = `${record.state.status}: ${record.state.blockedReason ?? ''}`; },
      state: (state: string) => w.finalStates.push(state), fallback: () => { throw new Error('unexpected fallback'); },
    });
    w.finalConnection.start();
  });
  await page.waitForFunction(() => (window as any).finalStates.includes('connected'));
  assert.equal(await page.evaluate(() => (window as any).finalSnapshots[0].cursor), 850);
  const finishInput = { sessionId, requestId: 'finish-ui', runId: 'r', status: 'failed' as const, epoch: 1, revision: 1,
    run: { id: 'r', sessionId, status: 'failed', completedAt: new Date().toISOString(), stopReason: 'provider disconnected', currentStep: 7 } };
  await control.finishRun(finishInput);
  await control.finishRun(finishInput);
  await page.waitForFunction(() => (window as any).finalEvents.some((record: any) => record.chunk.type === 'run_finished'));
  await new Promise(resolve => setTimeout(resolve, 100));
  const finalEvents = await page.evaluate(() => (window as any).finalEvents);
  assert.equal(finalEvents.length, 1);
  assert.equal(finalEvents[0].sequence, 851);
  assert.equal(finalEvents[0].state.status, 'failed');
  assert.equal(finalEvents[0].state.activeRunId, null);
  assert.equal(finalEvents[0].state.blockedReason, 'provider disconnected');
  assert.equal(await page.locator('#status').innerText(), 'failed: provider disconnected');
  await page.evaluate(() => (window as any).finalConnection.close());
  assert.deepEqual(errors, []);
  const screenshot = path.join(tmpdir(), 'synax-rust-ui-smoke.png');
  await page.screenshot({ path: screenshot });
  console.log(`Electron native UI adapter passed: Rust materialized snapshot through event 600, 50 live/reconnected events including a real Rust process restart without duplicates, 64-event credit limit, forged ACK rejection, slow-consumer resync, scoped/one-use tickets, and exactly-once live completion. Screenshot: ${screenshot}`);
} finally {
  await desktop?.close(); control.close();
  await stopRustRuntimeSidecar(runtime);
  await rm(root, { recursive: true, force: true });
}
