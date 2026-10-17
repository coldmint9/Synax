import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-terminal-'));
process.env.DATA_ROOT = path.join(root, 'node-data');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.SYNAX_RUNTIME_SIDECAR_STREAM = 'authoritative';

const { RustRuntimeSupervisor } = await import('../services/local-node/infrastructure/runtime/rust-sidecar.ts');
const { RuntimeSidecarClient } = await import('../services/local-node/modules/agent-runtime/sidecar/sidecar-client.ts');
const { terminalManager } = await import('../services/local-node/infrastructure/terminals/terminal-manager.ts');

const supervisor = new RustRuntimeSupervisor({ dataRoot: root });
let client: InstanceType<typeof RuntimeSidecarClient> | undefined;
const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

try {
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const cwd = path.join(root, 'workspace');
  await (await import('node:fs/promises')).mkdir(cwd, { recursive: true });
  const terminal = await terminalManager.create({
    projectId: 'terminal-smoke-project',
    rootId: 'primary',
    cwd,
    kind: 'service',
    title: 'D3 active terminal',
    command: 'printf "D3_BEFORE_RESTART\\n"; while true; do printf "D3_LIVE\\n"; sleep 0.05; done',
  });

  await waitFor(
    () => terminalManager.snapshot(terminal.id).data.includes('D3_BEFORE_RESTART'),
    'terminal did not produce its pre-restart marker',
  );
  const before = terminalManager.snapshot(terminal.id).sequence;
  await waitFor(async () => {
    const state = JSON.parse(new TextDecoder().decode(await client!.historyCommandGlobal({
      sessionId: 'terminals:terminal-smoke-project',
      requestId: `terminal-smoke-read-before:${before}`,
      operation: 'list_terminals',
      payload: {},
    }))) as { items?: Array<{ id?: string; state?: string; outputSequence?: number; outputTail?: string }> };
    const item = state.items?.find(value => value.id === terminal.id);
    return item?.state === 'active' && (item.outputSequence ?? 0) >= before && item.outputTail?.includes('D3_BEFORE_RESTART') === true;
  }, 'active PTY snapshot was not flushed to Rust history');

  const generation = supervisor.generation;
  supervisor.process.kill('SIGKILL');
  await waitFor(() => supervisor.generation > generation, 'sidecar did not restart');
  client.close();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });

  await waitFor(async () => {
    const state = JSON.parse(new TextDecoder().decode(await client!.historyCommandGlobal({
      sessionId: 'terminals:terminal-smoke-project',
      requestId: `terminal-smoke-read-after:${supervisor.generation}`,
      operation: 'list_terminals',
      payload: {},
    }))) as { items?: Array<{ id?: string; state?: string; outputSequence?: number; outputTail?: string; pid?: number }> };
    const item = state.items?.find(value => value.id === terminal.id);
    return item?.state === 'active' && (item.outputSequence ?? 0) > before && item.outputTail?.includes('D3_LIVE') === true && typeof item.pid === 'number';
  }, 'active PTY metadata/output did not recover after sidecar restart');

  const hydrated = await terminalManager.getAuthoritative(terminal.id, terminal.projectId);
  assert.equal(hydrated.id, terminal.id);
  assert.equal(hydrated.state, 'active');
  assert.equal(hydrated.pid, terminal.pid);
  await terminalManager.stop(terminal.id);
  console.log('runtime sidecar terminal smoke passed: active PTY metadata and bounded output flushed to Rust, sidecar restarted, and history recovered while PTY remained alive.');
} finally {
  client?.close();
  await terminalManager.shutdown().catch(() => {});
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
