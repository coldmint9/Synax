import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import NativeDatabase from 'libsql';
import { decodeEnvelope, encodeEnvelope } from '../packages/runtime-protocol/wire.js';

// This fixture exercises real HTTP, provider execution, worker IPC, RocksDB,
// WebSocket and host restart. It never seeds a session through a test-only API.
const root = await mkdtemp(path.join(tmpdir(), 'synax-v2-e2e-'));
const reportDir = path.resolve('out/runtime-v2-e2e');
await mkdir(reportDir, { recursive: true });
const checks: string[] = [];
let host: ChildProcess | undefined;
let socket: WebSocket | undefined;
let hostOutput = '';
let base = '';
let token = '';
let providerRequests = 0;
let toolRequested = false;
let toolObserved = false;
const answer = 'Synax Rust 2.0 main path reply';
const provider = http.createServer(async (request, response) => {
  if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  providerRequests++;
  const message = { role: 'assistant', content: answer };
  const shared = { id: 'chatcmpl-v2-e2e', created: Math.floor(Date.now() / 1000), model: 'gpt-4o-mini' };
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...shared, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }] }));
    return;
  }
  const readTool = body.tools?.find((tool: {function?: {name?: string}}) => tool.function?.name === 'file_read');
  if (readTool && !toolRequested) {
    toolRequested = true;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ ...shared, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {
      role: 'assistant', tool_calls: [{ index: 0, id: 'v2-read', type: 'function', function: { name: 'file_read', arguments: JSON.stringify({path:'e2e-input.txt'}) } }],
    }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...shared, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    response.end('data: [DONE]\n\n'); return;
  }
  toolObserved ||= Boolean(body.messages?.some((message: {role?:string;content?:unknown}) => message.role==='tool' && JSON.stringify(message.content).includes('RUST_REPOSITORY_TOOL_EVIDENCE')));
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ ...shared, object: 'chat.completion.chunk', choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...shared, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  response.end('data: [DONE]\n\n');
});
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (true) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function stopHost() {
  const child = host;
  host = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(timer); }
}
async function startHost() {
  const env = { ...process.env, DATA_ROOT: root, PORT: '0', NODE_ENV: 'test', LOG_LEVEL: 'error',
    SYNAX_DESKTOP_SIDECAR: '1', SYNAX_AGENT_SESSION_IN_PROCESS: '0',
    SYNAX_E2E_SQL_PROBE: path.join(root,'retired-sql.jsonl'),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${path.resolve('scripts/runtime-v2-sql-probe.cjs')}` };
  // Retired mode flags must have no role in selecting the runtime under test.
  for (const key of ['SYNAX_HISTORY_MODE', 'SYNAX_TRANSCRIPT_STORAGE', 'SYNAX_RUNTIME_SIDECAR_STREAM', 'SYNAX_RUNTIME_SIDECAR_ADMISSION', 'SYNAX_RUNTIME_SIDECAR_SOCKET', 'SYNAX_RUNTIME_SIDECAR_TOKEN', 'SYNAX_RUNTIME_SIDECAR_PORT']) delete env[key];
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'services/local-node/entrypoints/http-server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  host = child;
  child.stderr!.on('data', chunk => { hostOutput += String(chunk); });
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP host startup timed out')), 30_000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`HTTP host exited (${code})`)); });
    let stdout = '';
    child.stdout!.on('data', chunk => {
      hostOutput += String(chunk);
      stdout += String(chunk);
      const port = /^SYNAX_DESKTOP_READY:(\d+)$/m.exec(stdout)?.[1];
      if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); }
    });
  });
  token = (await readFile(path.join(root, 'runtime-access-token'), 'utf8')).trim();
}
async function api(endpoint: string, body?: unknown): Promise<any> {
  const response = await fetch(`${base}/api/agent-runtime${endpoint}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const value = await response.json();
  assert(response.ok, `${endpoint}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
let failure: unknown;
try {
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const port = (provider.address() as { port: number }).port;
  process.env.DATA_ROOT = root; process.env.NODE_ENV = 'test'; process.env.LOG_LEVEL = 'error';
  await writeFile(path.join(root, 'projects.json'), JSON.stringify({ items: [{ id: 'v2-e2e', source: { localPath: root } }] }));
  const { updateGlobalConfig } = await import('../services/local-node/infrastructure/runtime/config/config-store.js');
  updateGlobalConfig({ defaultApiProviderId: 'openai', providerConnections: {
    openai: { providerId: 'openai', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${port}/v1`, extra: { kind: 'api', apiFormat: 'openai', model: 'gpt-4o-mini' } },
  } }, 'runtime-v2-e2e');
  await writeFile(path.join(root,'e2e-input.txt'),'RUST_REPOSITORY_TOOL_EVIDENCE');
  await startHost();
  const created = await api('/sessions', { projectId: 'v2-e2e', profileId: 'synax', prompt: 'Reply with one short sentence.', workDir: root });
  const sessionId = created.session.id as string;
  assert(sessionId); checks.push('HTTP session creation');
  const { ticket } = await api(`/sessions/${sessionId}/runtime-ticket`, { clientId: 'v2-e2e' });
  socket = new WebSocket(ticket.url); socket.binaryType = 'arraybuffer';
  const observed: string[] = [];
  let subscribed = false;
  let socketError: Error | undefined;
  const send = (body: Parameters<typeof encodeEnvelope>[0]['body']) => socket!.send(encodeEnvelope({ requestId: 'v2-e2e', sessionId, epoch: 0, revision: 0, body }));
  socket.onopen = () => send({ type: 'hello', token: ticket.token, clientId: ticket.clientId });
  socket.onerror = () => { socketError = new Error('Rust WebSocket failed'); };
  socket.onmessage = event => {
    const envelope = decodeEnvelope(new Uint8Array(event.data as ArrayBuffer));
    const body = envelope.body;
    if (body.type === 'error') { socketError = new Error(`${body.code}: ${body.message}`); return; }
    if (body.type === 'ready') send({ type: 'subscribe', after: 0 });
    if (body.type === 'snapshot_response') subscribed = true;
    if (body.type === 'event_batch') {
      observed.push(...body.events.map(event => event.kind));
      const last = body.events.filter(event => !event.ephemeral).at(-1);
      if (last) send({ type: 'credit', throughSequence: last.sequence });
    }
  };
  await until(async () => { if (socketError) throw socketError; return subscribed; }, Boolean, 'Rust subscription');
  const accepted = await api(`/sessions/${sessionId}/runs`, { requestId: 'v2-e2e-turn', message: 'Say hello.', mode: 'turn' });
  const runId = accepted.run.id as string;
  const completed = await until(() => api(`/sessions/${sessionId}/runs/${runId}`), run => ['completed', 'failed', 'interrupted'].includes(run.status), 'provider turn');
  assert.equal(completed.status, 'completed', completed.stopReason);
  assert(providerRequests > 0);
  assert(toolRequested && toolObserved, 'provider must receive the real file tool result');
  checks.push('provider → file.read → persisted tool result'); checks.push('HTTP submit → forked provider worker → Rust completion');
  await until(async () => observed, events => events.includes('message_delta'), 'native WebSocket delta');
  checks.push('native WebSocket streaming');
  const messages = await api(`/sessions/${sessionId}/messages`);
  assert(messages.items.some((m: { content: string }) => m.content.includes(answer)));
  socket.close(); socket = undefined;
  await stopHost(); await startHost();
  const restored = await api(`/sessions/${sessionId}/messages`);
  assert(restored.items.some((m: { content: string }) => m.content.includes(answer)));
  checks.push('host restart → HTTP Rust history');
  const restoredTools = await api(`/sessions/${sessionId}/tool-calls`);
  assert(restoredTools.items.some((call: {toolId:string;status:string})=>call.toolId==='file.read'&&call.status==='completed'));
  const second = await api(`/sessions/${sessionId}/runs`, {requestId:'v2-e2e-second-turn',message:'Continue from the persisted tool evidence.',mode:'turn'});
  const secondRun = await until(()=>api(`/sessions/${sessionId}/runs/${second.run.id}`),run=>['completed','failed','interrupted'].includes(run.status),'second turn after restart');
  assert.equal(secondRun.status,'completed',secondRun.stopReason);
  const finalHistory = await api(`/sessions/${sessionId}/messages`);
  assert.equal(finalHistory.items.filter((message:{role:string;content:string})=>message.role==='assistant'&&message.content.includes(answer)).length,2);
  checks.push('persisted tool evidence → second turn after restart');
  await stopHost();
  const db = new NativeDatabase(path.join(root, 'context.db'), { readonly: true });
  let oldTables: Array<{ name: string }>;
  try { oldTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'agent_runtime_*' OR name GLOB 'conversation_*' OR name GLOB 'jsonl_*' OR name GLOB 'transcript_*' OR name='agent_plan_artifacts' OR name='terminal_sessions')").all() as Array<{ name: string }>; }
  finally { db.close(); }
  assert.deepEqual(oldTables, [], '2.0 runtime must not create old runtime SQL tables');
  checks.push('no old runtime SQL tables');
  const attempts = await readFile(path.join(root,'retired-sql.jsonl'),'utf8').catch(()=> '');
  assert.equal(attempts, '', 'online path must not query retired SQL tables, including caught errors');
  checks.push('no retired SQL reads or writes');
} catch (error) { failure = error; }
finally {
  socket?.close(); await stopHost();
  provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  await writeFile(path.join(reportDir, 'host.log'), hostOutput);
  await writeFile(path.join(reportDir, 'result.json'), JSON.stringify({ ok: !failure, checks, error: failure instanceof Error ? failure.message : failure ? String(failure) : null, dataRoot: failure ? root : undefined }, null, 2));
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log('Rust 2.0 main path E2E passed:', checks.join(' → '));
