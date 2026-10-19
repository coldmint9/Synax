import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-provider-worker-'));
const provider = http.createServer((request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404); response.end(); return;
  }
  request.resume();
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const base = { id: 'chatcmpl-synax-worker', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-4o-mini' };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Rust worker provider output' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
});
const listen = promisify(provider.listen.bind(provider)) as (port: number, host: string) => Promise<void>;
const close = promisify(provider.close.bind(provider));
let supervisor: { start(): Promise<void>; stop(): Promise<void>; socketPath: string; token: string };
let runtime: { stop(): Promise<void> } | undefined;
try {
  await mkdirProjects(root);
  await listen(0, '127.0.0.1');
  const port = (provider.address() as { port: number }).port;
  Object.assign(process.env, {
    DATA_ROOT: root,
    NODE_ENV: 'test',
    SYNAX_RUNTIME_SIDECAR_SUPERVISOR: '1',
    SYNAX_RUNTIME_SIDECAR_STREAM: 'authoritative',
    SYNAX_AGENT_LOOP_ENGINE: 'rust',
    SYNAX_AGENT_SESSION_IN_PROCESS: '0',
  });
  const { RustRuntimeSupervisor } = await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
  supervisor = new RustRuntimeSupervisor({ dataRoot: root });
  const { updateGlobalConfig } = await import('../services/local-node/infrastructure/runtime/config/config-store.js');
  updateGlobalConfig({
    defaultApiProviderId: 'openai',
    providerConnections: {
      openai: { providerId: 'openai', apiKey: 'local-test', baseUrl: `http://127.0.0.1:${port}/v1`, extra: { kind: 'api', apiFormat: 'openai', model: 'gpt-4o-mini' } },
    },
  }, 'runtime-worker-smoke');
  await supervisor.start();
  runtime = supervisor;
  const { agentSessionRuntime } = await import('../services/local-node/modules/agent-runtime/session-runtime.js');
  const { agentRuntimeStore } = await import('../services/local-node/modules/agent-runtime/session-store.js');
  const { RunCoordinator } = await import('../services/local-node/modules/agent-runtime/run-coordinator.js');
  const { ensureSynaxAgentRegistered, ensureLegacyGoalProfileRegistered } = await import('../services/local-node/modules/agent-runtime/synax/index.js');
  ensureSynaxAgentRegistered();
  ensureLegacyGoalProfileRegistered();
  const session = agentSessionRuntime.create({ projectId: 'provider-smoke', profileId: 'synax', prompt: 'Respond with one short sentence.', workDir: root });
  const coordinator = new RunCoordinator();
  const accepted = await coordinator.submitAsync(session.id, { message: 'Say hello through the local provider.' }, 'provider-worker-smoke');
  await coordinator.waitForIdle();
  const run = agentRuntimeStore.getRun(accepted.run.id);
  const messages = agentRuntimeStore.listMessages(session.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.metadata.engine, 'rust');
  assert.equal(typeof run.metadata.hostProcessId, 'number');
  assert.notEqual(run.metadata.hostProcessId, process.pid, 'tool executor must be a separate worker process');
  assert(messages.some(message => message.role === 'assistant' && message.content.includes('Rust worker provider output')));
  const sidecarClient = await import('../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js');
  const client = new sidecarClient.RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const events = await client.replay(session.id, 0);
  assert(events.events.some(event => event.kind === 'message_delta'));
  const history = JSON.parse(new TextDecoder().decode(await client.historyCommand({ sessionId: session.id, requestId: 'provider-history-runs', operation: 'list_runs', payload: {} }))) as { items: Array<{ id: string }> };
  assert(history.items.some(item => item.id === accepted.run.id));
  const head = JSON.parse(new TextDecoder().decode(await client.historyCommand({ sessionId: session.id, requestId: 'provider-history-head', operation: 'head_read', payload: {} }))) as { objectId?: string; revision: number };
  assert(typeof head.objectId === 'string' && head.revision > 0, 'terminal history must publish a reachable head');
  const integrity = JSON.parse(new TextDecoder().decode(await client.historyCommand({ sessionId: '__system__', requestId: 'provider-history-verify', operation: 'verify', payload: {} }))) as { ok: boolean };
  assert.equal(integrity.ok, true);
  client.close();
  console.log('Real provider worker smoke passed: forked agent-session-runner → local OpenAI-compatible HTTP provider → Node coordinator → Rust authoritative stream/history.');
} finally {
  await runtime?.stop().catch(() => {});
  if (!runtime) await supervisor.stop().catch(() => {});
  await close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}

async function mkdirProjects(dataRoot: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, 'projects.json'), JSON.stringify({ items: [{ id: 'provider-smoke', source: { localPath: dataRoot } }] }));
}
