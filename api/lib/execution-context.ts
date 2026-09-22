import { assertTransactionSafe } from '../db/transaction-safety.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type NativeDatabase from 'libsql';

export interface RuntimeExecutionContext { sessionId: string; runId: string; epoch: string; hostId: string }
const contexts = new AsyncLocalStorage<RuntimeExecutionContext | null | undefined>();
export function runWithExecutionContext<T>(context: RuntimeExecutionContext | undefined, action: () => T): T { return contexts.run(context, action); }
export function currentExecutionContext(): RuntimeExecutionContext | undefined { return contexts.getStore() ?? undefined; }
export function outsideExecutionContext<T>(action: () => T): T { return contexts.run(undefined, action); }
export function withoutExecutionContext<T>(action: () => T): T { return contexts.run(null, action); }

export function assertDatabaseWriteAllowed(sqlite: NativeDatabase.Database, databasePath: string): void {
  assertTransactionSafe(sqlite);
  const context = contexts.getStore();
  if (context === null) return; // Trusted lifecycle bookkeeping, never model-facing tools.
  const hostId = process.env.SYNAX_RUNTIME_HOST_ID;
  const runtimeRoot = process.env.SYNAX_RUNTIME_DATA_ROOT;
  if (hostId && runtimeRoot && path.resolve(databasePath) === path.resolve(runtimeRoot, 'context.db')) {
    const host = sqlite.prepare('SELECT host_id FROM runtime_host_lock WHERE id = 1').get() as { host_id: string } | undefined;
    if (host?.host_id !== hostId) throw Object.assign(new Error('Runtime host has been superseded.'), { code: 'EXECUTION_SUPERSEDED' });
  }
  if (!context) return;
  const row = sqlite.prepare("SELECT json_extract(metadata_json, '$.executionLease.epoch') AS epoch, json_extract(metadata_json, '$.executionLease.closed') AS closed FROM agent_runtime_runs WHERE id = ? AND session_id = ?")
    .get(context.runId, context.sessionId) as { epoch: string | null; closed: number | null } | undefined;
  if (!row || row.epoch !== context.epoch || row.closed) throw Object.assign(new Error('Execution lease has been superseded or closed.'), { code: 'EXECUTION_SUPERSEDED' });
  const generation=sqlite.prepare("SELECT r.version_epoch AS run_epoch,h.epoch AS session_epoch FROM agent_runtime_runs r JOIN conversation_v3_heads h ON h.session_id=r.session_id WHERE r.id=? AND r.session_id=?").get(context.runId,context.sessionId) as {run_epoch:number|null;session_epoch:number}|undefined;
  if(generation&&generation.run_epoch!==generation.session_epoch)throw Object.assign(new Error('Execution history epoch has been superseded.'),{code:'EXECUTION_SUPERSEDED'});
}

export async function* withinExecutionContext<T>(context: RuntimeExecutionContext | undefined, source: AsyncGenerator<T>): AsyncGenerator<T> {
  if (!context) { yield* source; return; }
  try {
    while (true) {
      const result = await contexts.run(context, () => source.next());
      if (result.done) return;
      yield result.value;
    }
  } finally { await contexts.run(context, () => source.return(undefined as never)); }
}
