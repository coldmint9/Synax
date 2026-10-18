import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { RustRuntimeSupervisor } from './rust-sidecar.js';
import { RuntimeSidecarClient } from '../../modules/agent-runtime/sidecar/sidecar-client.js';
import { assertExecutionContextCurrent, withinExecutionContext, type RuntimeExecutionContext } from './execution-context.js';

let root: string;
let supervisor: RustRuntimeSupervisor;
let client: RuntimeSidecarClient;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'synax-execution-fence-'));
  supervisor = new RustRuntimeSupervisor({ dataRoot: root });
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
});
afterAll(async () => {
  client?.close();
  await supervisor?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function command(sessionId: string, operation: string, payload: unknown) {
  const state = await client.snapshot(sessionId);
  return client.controlCommand({ sessionId, requestId: randomUUID(), epoch: state.epoch, revision: state.revision, operation, payload });
}
async function start() {
  const sessionId = randomUUID();
  const context: RuntimeExecutionContext = { sessionId, runId: randomUUID(), epoch: randomUUID(), hostId: process.env.SYNAX_RUNTIME_HOST_ID ?? 'test-host' };
  const run = { id: context.runId, sessionId, status: 'queued', startedAt: new Date().toISOString(), metadata: {} };
  await client.seedUi(sessionId, Buffer.from(JSON.stringify({ id: sessionId, projectId: 'test', status: 'queued', updatedAt: run.startedAt })));
  await client.admitRun({ sessionId, requestId: randomUUID(), bodyHash: 'test', runId: run.id, run, epoch: 1, revision: 0 });
  await client.activateRun({ sessionId, requestId: randomUUID(), run, epoch: 1, revision: 1 });
  await command(sessionId, 'execution_open', context);
  return { context, run };
}

it.each(['completed', 'failed', 'blocked'] as const)('allows %s cleanup until the coordinator durably finishes the run', async (status) => {
  const { context } = await start();
  const seen: string[] = [];
  const source = withinExecutionContext(context, (async function* () {
    yield 'running';
    await command(context.sessionId, 'session_patch', { patch: { status: status === 'blocked' ? 'completed' : status, activeRunId: null } });
    yield 'terminal';
    yield 'done';
    seen.push('cleanup');
  })());
  for await (const chunk of source) seen.push(chunk);
  expect(seen).toEqual(['running', 'terminal', 'done', 'cleanup']);
});

it('keeps UI run metadata and UI status from granting or revoking execution authority', async () => {
  const { context } = await start();
  await command(context.sessionId, 'run_patch', { runId: context.runId, patch: { metadata: {
    executionLease: { ...context, epoch: 'stale-ui-generation', closed: true },
  } } });
  await expect(assertExecutionContextCurrent(context)).resolves.toBeUndefined();
  await expect(assertExecutionContextCurrent({ ...context, epoch: 'stale-ui-generation' })).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
});

it('rejects different run, host and generation identities while leaving the valid executor usable', async () => {
  const { context } = await start();
  for (const field of ['runId', 'hostId', 'epoch'] as const) {
    await expect(assertExecutionContextCurrent({ ...context, [field]: 'different' })).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
  }
  await expect(assertExecutionContextCurrent(context)).resolves.toBeUndefined();
});

it('does not replay fence checks or create events and receipts when checking a lease', async () => {
  const { context } = await start();
  const before = await client.snapshot(context.sessionId);
  const check = { sessionId: context.sessionId, requestId: 'reused-check', epoch: 0, revision: 0, operation: 'execution_check', payload: context };
  await client.controlCommand(check);
  await client.controlCommand(check);
  expect(await client.snapshot(context.sessionId)).toEqual(before);
  await command(context.sessionId, 'execution_close', context);
  await expect(client.controlCommand(check)).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
  await expect(command(context.sessionId, 'execution_open', context)).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
});

it('prevents a competing open or delayed close/finish from revoking a resumed generation', async () => {
  const { context, run } = await start();
  const next = { ...context, epoch: randomUUID() };
  await expect(command(context.sessionId, 'execution_open', next)).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
  await command(context.sessionId, 'execution_close', context);
  await command(context.sessionId, 'execution_open', next);
  await expect(assertExecutionContextCurrent(context)).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
  await expect(command(context.sessionId, 'execution_close', context)).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
  const state = await client.snapshot(context.sessionId);
  await expect(client.finishRun({ sessionId: context.sessionId, runId: run.id, requestId: randomUUID(),
    epoch: state.epoch, revision: state.revision, status: 'completed', run: { ...run, status: 'completed', metadata: { executionLease: context } },
  })).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
  await expect(assertExecutionContextCurrent(next)).resolves.toBeUndefined();
});

it('closes execution authority atomically with terminal completion', async () => {
  const { context, run } = await start();
  const state = await client.snapshot(context.sessionId);
  await client.finishRun({ sessionId: context.sessionId, requestId: randomUUID(), runId: run.id,
    epoch: state.epoch, revision: state.revision, status: 'completed', run: { ...run, status: 'completed', metadata: { executionLease: context } } });
  await expect(assertExecutionContextCurrent(context)).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
  const control = await command(context.sessionId, 'read', {});
  expect(JSON.parse(Buffer.from(control.stateJson).toString()).executionLease).toEqual({ ...context, closed: true });
});

it('retains an open execution lease across an actual Rust process crash and reconnect', async () => {
  const { context } = await start();
  const generation = supervisor.generation;
  const exited = once(supervisor.process, 'exit');
  supervisor.process.kill('SIGKILL');
  await exited;
  // The client retries during recovery; do not manually recreate it or reopen the lease.
  await expect(assertExecutionContextCurrent(context)).resolves.toBeUndefined();
  expect(supervisor.generation).toBeGreaterThan(generation);
  await command(context.sessionId, 'execution_close', context);
  await expect(assertExecutionContextCurrent(context)).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
});
