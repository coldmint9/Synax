import { assertTransactionSafe } from '../database/transaction-safety.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type NativeDatabase from 'libsql';
import { RuntimeSidecarClient } from '../../modules/agent-runtime/sidecar/sidecar-client.js';

export interface RuntimeExecutionContext { sessionId: string; runId: string; epoch: string; hostId: string }
const contexts = new AsyncLocalStorage<RuntimeExecutionContext | null | undefined>();
type AuthoritativeExecutionFence = (context: RuntimeExecutionContext) => Promise<void>;
let authoritativeExecutionFence: AuthoritativeExecutionFence | undefined;
let sidecarFenceClient: { socketPath: string; token: string; client: RuntimeSidecarClient } | undefined;

export function runWithExecutionContext<T>(context: RuntimeExecutionContext | undefined, action: () => T): T { return contexts.run(context, action); }
export function currentStorageExecutionContext(): RuntimeExecutionContext | null | undefined { return contexts.getStore(); }
export function currentExecutionContext(): RuntimeExecutionContext | undefined { return contexts.getStore() ?? undefined; }
export function outsideExecutionContext<T>(action: () => T): T { return contexts.run(undefined, action); }
export function withoutExecutionContext<T>(action: () => T): T { return contexts.run(null, action); }

/**
 * Install the host's asynchronous authority check. The production default is
 * the Rust UI projection; tests and embedded hosts may provide an equivalent
 * control/projection adapter without importing the runtime facade here.
 */
export function setAuthoritativeExecutionFence(fence: AuthoritativeExecutionFence | undefined): void {
  authoritativeExecutionFence = fence;
}

function superseded(message: string): Error {
  return Object.assign(new Error(message), { code: 'EXECUTION_SUPERSEDED' });
}

function fenceUnavailable(message: string, cause?: unknown): Error {
  const error = Object.assign(new Error(message), { code: 'EXECUTION_FENCE_UNAVAILABLE' });
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

function assertHostFence(context: RuntimeExecutionContext): void {
  const hostId = process.env.SYNAX_RUNTIME_HOST_ID;
  if (hostId && context.hostId !== hostId) throw superseded('Runtime host has been superseded.');
}

function getSidecarFenceClient(): RuntimeSidecarClient {
  const socketPath = process.env.SYNAX_RUNTIME_SIDECAR_SOCKET;
  const token = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
  if (!socketPath || !token) throw fenceUnavailable('Runtime sidecar execution fence is not configured.');
  if (!sidecarFenceClient || sidecarFenceClient.socketPath !== socketPath || sidecarFenceClient.token !== token) {
    sidecarFenceClient?.client.close();
    sidecarFenceClient = { socketPath, token, client: new RuntimeSidecarClient({ socketPath, token }) };
  }
  return sidecarFenceClient.client;
}

async function defaultAuthoritativeExecutionFence(context: RuntimeExecutionContext): Promise<void> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(Buffer.from(await getSidecarFenceClient().uiSnapshot(context.sessionId)).toString('utf8'));
  } catch (error) {
    sidecarFenceClient?.client.close();
    sidecarFenceClient = undefined;
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EXECUTION_SUPERSEDED') throw error;
    throw fenceUnavailable('Rust execution fence could not be read.', error);
  }
  const value = snapshot as {
    session?: { id?: unknown; activeRunId?: unknown };
    run?: { id?: unknown; metadata?: { executionLease?: { epoch?: unknown; closed?: unknown } } } | null;
  };
  const lease = value.run?.metadata?.executionLease;
  if (value.session?.id !== context.sessionId || value.session.activeRunId !== context.runId ||
      value.run?.id !== context.runId || lease?.epoch !== context.epoch || lease.closed === true) {
    throw superseded('Execution lease has been superseded or closed.');
  }
}

/**
 * Async lease boundary for authoritative hosts. It runs before each provider
 * turn/stream advancement, so the synchronous SQLite guard never needs to
 * query the legacy run or history-head tables while a write transaction is
 * open.
 */
export async function assertExecutionContextCurrent(context: RuntimeExecutionContext | undefined): Promise<void> {
  if (!context) return;
  assertHostFence(context);
  await (authoritativeExecutionFence ?? defaultAuthoritativeExecutionFence)(context);
}

export function assertDatabaseWriteAllowed(sqlite: NativeDatabase.Database, databasePath: string): void {
  assertTransactionSafe(sqlite);
  const context = contexts.getStore();
  if (context === null) return; // Trusted lifecycle bookkeeping, never model-facing tools.
  const hostId = process.env.SYNAX_RUNTIME_HOST_ID;
  const runtimeRoot = process.env.SYNAX_RUNTIME_DATA_ROOT;
  if (hostId && runtimeRoot && path.resolve(databasePath) === path.resolve(runtimeRoot, 'context.db')) {
    // runtime_host_lock is the process-level host fence. It is independent of
    // the execution lease and remains valid for both authoritative and fixture
    // databases.
    const host = sqlite.prepare('SELECT host_id FROM runtime_host_lock WHERE id = 1').get() as { host_id: string } | undefined;
    if (host?.host_id !== hostId) throw superseded('Runtime host has been superseded.');
  }
  if (!context) return;
  // The Rust projection is the only execution fence. Legacy runtime tables
  // are intentionally never consulted by the synchronous SQLite guard.

}

export async function* withinExecutionContext<T>(context: RuntimeExecutionContext | undefined, source: AsyncGenerator<T>): AsyncGenerator<T> {
  if (!context) { yield* source; return; }
  try {
    while (true) {
      await assertExecutionContextCurrent(context);
      const result = await contexts.run(context, () => source.next());
      if (result.done) return;
      yield result.value;
    }
  } finally { await contexts.run(context, () => source.return(undefined as never)); }
}
