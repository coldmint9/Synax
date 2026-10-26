/** Compare the installed protocol's snapshot/CAS loop with atomic process
 * bookkeeping against one isolated, real Rust runtime. No application data. */
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(path.join(os.tmpdir(), 'synax-control-benchmark-'));
process.env.DATA_ROOT = root;
process.env.LOG_LEVEL = 'error';
process.env.RUST_LOG = 'error';
const { RustRuntimeSupervisor } = await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
const { RuntimeSidecarClient, RuntimeSidecarError } = await import('../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js');
const supervisor = new RustRuntimeSupervisor({ dataRoot: root,
  binaryPath: process.env.SYNAX_RUNTIME_SIDECAR_BIN ?? path.resolve('runtime-sidecar/target/debug/synax-runtime-sidecar'),
});
let client: InstanceType<typeof RuntimeSidecarClient> | undefined;
try {
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const remote = client;
  const ready = await remote.connect();
  if (!ready.capabilities.includes('control_current_v1')) throw new Error('Rebuild the sidecar before benchmarking.');
  for (const atomic of [false, true]) {
    const sessions = Array.from({ length: 6 }, (_, i) => `${atomic ? 'atomic' : 'legacy'}-${i}`);
    for (const [index, id] of sessions.entries()) {
      await remote.seedUi(id, Buffer.from(JSON.stringify({ id, projectId: 'benchmark', status: 'queued',
        parentSessionId: index < 3 ? null : sessions[index - 3], updatedAt: new Date().toISOString(),
        sessionMetadata: { mcpToolDefinitions: 'x'.repeat(160_000) },
      })));
    }
    let rpcCount = 0, conflicts = 0, failed = 0, responseBytes = 0;
    const timings: number[] = [];
    const start = performance.now();
    await Promise.all(sessions.flatMap(sessionId => Array.from({ length: 4 }, (_, worker) => (async () => {
      for (let index = 0; index < 4; index++) {
        const lease = { leaseId: `${worker}-${index}`, hostId: 'benchmark-host', pid: index + 1, state: 'active' };
        for (const operation of ['lease_open', 'lease_close']) {
          const requestId = randomUUID();
          const started = performance.now();
          for (let attempt = 0; ; attempt++) {
            const fence = atomic ? { epoch: 0, revision: 0 } : (rpcCount++, await remote.snapshot(sessionId));
            try {
              rpcCount++;
              const result = await remote.controlCommand({ sessionId, requestId, epoch: fence.epoch, revision: fence.revision,
                operation: atomic ? 'lease_update' : operation,
                payload: atomic ? { operation, lease } : lease,
              });
              responseBytes += result.stateJson.length;
              break;
            } catch (error) {
              if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT') throw error;
              conflicts++;
              if (attempt >= 7) { failed++; break; }
            }
          }
          timings.push(performance.now() - started);
        }
      }
    })())));
    timings.sort((a, b) => a - b);
    const states = await Promise.all(sessions.map(async sessionId => {
      const snapshot = await remote.snapshot(sessionId);
      const result = await remote.controlCommand({ sessionId, requestId: randomUUID(), epoch: 0, revision: 0, operation: 'read_current' });
      return { revision: snapshot.revision, cursor: snapshot.cursor,
        leases: JSON.parse(Buffer.from(result.stateJson).toString()).processLeases.length };
    }));
    console.log(JSON.stringify({ mode: atomic ? 'atomic' : 'legacy', sessions: 6, writersPerSession: 4, operations: timings.length,
      milliseconds: Math.round(performance.now() - start), rpcCount, conflicts, failed, responseBytes,
      p50Ms: Math.round(timings[Math.floor(timings.length * .5)]), p95Ms: Math.round(timings[Math.floor(timings.length * .95)]),
      revisionChanges: states.reduce((n, s) => n + s.revision, 0), streamEvents: states.reduce((n, s) => n + s.cursor, 0),
      remainingLeases: states.reduce((n, s) => n + s.leases, 0),
    }));
    if (atomic && (conflicts || failed || states.some(s => s.revision || s.cursor || s.leases))) throw new Error('Atomic lease invariant failed.');
  }
} finally {
  client?.close();
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
