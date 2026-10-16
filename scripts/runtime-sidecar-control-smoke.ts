import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-controls-'));
const supervisor = new RustRuntimeSupervisor({ dataRoot: root });
let client: RuntimeSidecarClient | undefined;
try {
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  await client.seedUi('s', json({ id: 's', projectId: 'p', status: 'queued', updatedAt: new Date().toISOString() }));

  const command = async (requestId: string, operation: string, payload: unknown) => {
    const snapshot = await client!.snapshot('s');
    return client!.controlCommand({ sessionId: 's', requestId, operation, payload,
      epoch: snapshot.epoch, revision: snapshot.revision });
  };
  const permission = { id: 'permission-1', sessionId: 's', runId: 'r', action: 'ask', reason: 'write requires approval',
    resumeToken: 'permission:1', userReply: null, resolvedAt: null };
  const requested = await command('permission-request', 'permission_request', permission);
  assert.equal(requested.revision, 1);
  const retry = await client.controlCommand({ sessionId: 's', requestId: 'permission-request', operation: 'permission_request', payload: permission, epoch: 1, revision: 0 });
  assert.equal(retry.revision, 1);
  const afterPermission = await command('permission-reply', 'permission_reply', { id: 'permission-1', reply: 'once' });
  assert.equal(afterPermission.revision, 2);

  const interaction = { id: 'interaction-1', sessionId: 's', runId: 'r', stepId: 'step', toolCallId: 'call', kind: 'clarification',
    revision: 1, status: 'pending', request: { title: 'Choose a directory' }, response: null, createdAt: new Date().toISOString(), resolvedAt: null };
  const interactionRequested = await command('interaction-request', 'interaction_request', interaction);
  assert.equal(interactionRequested.revision, 3);
  await command('interaction-reply', 'interaction_reply', { id: 'interaction-1', revision: 1, reply: { revision: 1, action: 'submit', answers: { q0: 'src' } } });
  await command('interaction-consume', 'interaction_consume', { id: 'interaction-1' });

  const stopping = await command('stop-begin', 'stop_begin', { runId: 'r', reason: 'user requested' });
  assert.equal(JSON.parse(new TextDecoder().decode(stopping.stateJson)).runtimeControl.state, 'stopping');
  const unconfirmed = await command('stop-unconfirmed', 'stop_unconfirmed', { runId: 'r', reason: 'worker did not exit' });
  assert.equal(JSON.parse(new TextDecoder().decode(unconfirmed.stateJson)).runtimeControl.state, 'unconfirmed');
  await command('resume', 'resume', { runId: 'r' });
  await command('session-patch', 'session_patch', { patch: { sessionMetadata: { pinned: true }, title: 'Rust control session' } });
  const projected = JSON.parse(new TextDecoder().decode(await client.uiSnapshot('s')));
  assert.equal(projected.session.sessionMetadata.pinned, true);
  assert.equal(projected.session.title, 'Rust control session');

  const events = await client.replay('s', 0);
  assert.deepEqual(events.events.map(event => event.kind), [
    'permission_requested', 'permission_resolved', 'interaction_requested', 'interaction_resolved',
    'interaction_consumed', 'stop_begin', 'stop_unconfirmed', 'run_resumed', 'session_updated',
  ]);
  client.close(); client = undefined;
  const generation = supervisor.generation;
  supervisor.process.kill('SIGKILL');
  const deadline = Date.now() + 7000;
  while (supervisor.generation <= generation) {
    if (Date.now() >= deadline) throw new Error('Rust control smoke restart timed out.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const state = JSON.parse(new TextDecoder().decode((await command('control-read-after-restart', 'read', {})).stateJson)) as {
    permissions: Array<{ id: string; userReply: string }>;
    interactions: Array<{ id: string; status: string }>;
    runtimeControl: unknown;
  };
  assert.equal(state.permissions[0].userReply, 'once');
  assert.equal(state.interactions[0].status, 'answered');
  assert.equal(state.runtimeControl, null);
  assert.equal((await client.replay('s', 0)).events.length, 9);
  console.log('Rust control smoke passed: permission/interaction/stop/resume commands are fenced, receipt-idempotent, projected, replayable, and recover after sidecar restart.');
} finally {
  client?.close();
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
