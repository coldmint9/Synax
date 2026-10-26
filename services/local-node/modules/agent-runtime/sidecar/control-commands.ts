import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeSidecarClient, RuntimeSidecarError } from './sidecar-client.js';
import { logger } from '../../../infrastructure/runtime/logger.js';

type Fence = { epoch: number; revision: number; activeRunId?: string };
type Pending = { tail: Promise<void>; count: number };
const queues = new Map<string, Pending>();
const MAX_PENDING = 128;
const CRITICAL = new Set(['execution_open', 'execution_close', 'stop_begin', 'stop_cancel', 'stop_unconfirmed', 'resume']);

/** Serialize read/compare/write as one unit across clients in this process.
 * Critical stop/ownership operations retain their independent reserved lane. */
export async function withSessionRevision<T>(
  client: RuntimeSidecarClient, sessionId: string, operation: string,
  apply: (fence: Fence) => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([client.coordinationKey, sessionId, CRITICAL.has(operation)]);
  let queue = queues.get(key);
  if (!queue) queues.set(key, queue = { tail: Promise.resolve(), count: 0 });
  if (queue.count >= MAX_PENDING) throw new Error('Session control queue is full.');
  const previous = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>(resolve => { release = resolve; });
  queue.count++;
  try {
    await previous;
    // Pin the epoch for the whole operation. A conflicting write can update
    // revision; a takeover/stop must never silently rebase the caller's epoch.
    const fence = await client.snapshot(sessionId);
    const deadline = Date.now() + 5_000;
    for (let attempt = 0; ; attempt++) {
      try { return await apply(fence); }
      catch (error) {
        if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT') throw error;
        // An interaction/document CAS has its own revision and must be
        // returned to its caller, not confused with the session fence.
        if (error.expected !== undefined && error.expected !== fence.revision) throw error;
        if (attempt >= 7 || Date.now() >= deadline) {
          logger.warn({ sessionId, operation, attempts: attempt + 1, code: error.code }, 'Session control contention exceeded retry budget');
          throw error;
        }
        await delay(Math.min(160, 5 * 2 ** attempt) * (0.5 + Math.random()));
        if (Number.isSafeInteger(error.actual) && error.actual! > fence.revision) {
          // The rejection already supplies the authoritative revision. Avoid
          // another snapshot RPC; the next write still checks the pinned epoch.
          fence.revision = error.actual!;
        } else {
          const fresh = await client.snapshot(sessionId);
          if (fresh.epoch !== fence.epoch) throw new RuntimeSidecarError({
            type: 'error', code: 'STALE_EPOCH', message: 'Session epoch changed during control update.',
            expected: fence.epoch, actual: fresh.epoch,
          });
          fence.revision = fresh.revision;
        }
      }
    }
  } finally {
    release();
    if (--queue.count === 0 && queues.get(key) === queue) queues.delete(key);
  }
}

export interface ControlInput { sessionId: string; requestId: string; operation: string; payload?: unknown }

/** Capability negotiation keeps mixed Node/sidecar versions safe: a legacy
 * runtime receives only its original, fenced commands. */
export async function executeControlCommand(client: RuntimeSidecarClient, input: ControlInput) {
  const { operation, payload } = input;
  if (operation === 'execution_check') return client.controlCommand({ ...input, epoch: 0, revision: 0 });
  if (['read', 'lease_open', 'lease_close'].includes(operation)) {
    const ready = await client.connect();
    if (ready.capabilities.includes('control_current_v1')) {
      return client.controlCommand({ ...input, epoch: 0, revision: 0,
        operation: operation === 'read' ? 'read_current' : 'lease_update',
        payload: operation === 'read' ? undefined : { operation, lease: payload },
      });
    }
  }
  return withSessionRevision(client, input.sessionId, operation, fence =>
    client.controlCommand({ ...input, epoch: fence.epoch, revision: fence.revision }));
}
