/** One-time 1.x SQLite decoding. No online runtime imports belong in this module. */
export type Row = Record<string, unknown>;
export interface SessionBundle { session: Row; tables: Record<string, Row[]> }

export const historyTables = {
  agent_runtime_messages: ['runtime.message', 'list_messages'],
  agent_runtime_runs: ['runtime.run', 'list_runs'],
  agent_runtime_run_steps: ['runtime.step', 'list_steps'],
  agent_runtime_run_parts: ['runtime.part', 'list_parts'],
  agent_runtime_tool_calls: ['runtime.tool_call', 'list_tool_calls'],
  agent_runtime_events: ['runtime.event', 'list_events'],
  agent_runtime_artifacts: ['runtime.artifact', 'list_artifacts'],
  agent_runtime_context_bundles: ['runtime.context', 'list_contexts'],
  agent_runtime_work: ['runtime.work', 'list_work'],
  agent_plan_artifacts: ['runtime.plan', 'list_plans'],
  agent_runtime_aux_usage: ['runtime.aux_usage', 'list_aux_usage'],
  agent_runtime_thinking_summaries: ['runtime.thinking', 'list_thinking'],
  agent_runtime_compaction_summaries: ['runtime.compaction', 'list_compactions'],
} as const;

export const exportTables = [
  ...Object.keys(historyTables),
  'agent_runtime_permissions', 'agent_runtime_interactions',
  'agent_runtime_stream_records',
];

const interruptedStatuses = new Set(['running', 'queued', 'stopping']);
function decode(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
export function nativeRow(table: string, row: Row): Row {
  if (table === 'agent_runtime_work' && Object.hasOwn(row, 'payload_json')) return { ...decode(row.payload_json) as Row, id: row.id, sessionId: row.session_id };
  const result: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (['_metadata', '_rowid', 'version_epoch', '__synaxExecutionEpoch'].includes(key)) continue;
    const name = key.replace(/_json$/, '').replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    result[name] = key.endsWith('_json') ? decode(value) : value;
  }
  if (table === 'agent_runtime_run_steps' && Object.hasOwn(result, 'stepIndex')) {
    result.index = result.stepIndex;
    delete result.stepIndex;
  }
  if (table === 'agent_runtime_runs') {
    result.metadata ??= {};
    result.model ??= null;
    result.currentStep ??= 0;
    result.triggerMessageId ??= null;
    result.stopReason ??= null;
    result.completedAt ??= null;
    if (interruptedStatuses.has(String(result.status))) {
      result.status = 'interrupted';
      result.stopReason = 'Runtime migrated to 2.0.0';
    }
    const metadata = result.metadata as Row;
    delete metadata.executionLease;
  }
  if (table === 'agent_runtime_messages') {
    result.role ??= 'assistant';
    result.runId ??= null;
    result.stepId ??= null;
    result.metadata ??= {};
  }
  return result;
}

export function nativeSession(item: SessionBundle): Row {
  const row = nativeRow('agent_runtime_sessions', item.session);
  const metadata = { ...row.sessionMetadata as Row };
  delete metadata.historyStorage;
  delete metadata.historyPayloadStorage;
  delete metadata.runtimeControl;
  const session: Row = {
    parentSessionId: null, childSessionIds: [], nodeId: null, profileId: 'synax',
    title: null, prompt: '', contextSnapshotId: null, thinkingMode: 'standard',
    reasoningEffort: null, permissionRules: [], skillIds: [], mcpServerIds: [],
    completedAt: null, resultSummary: null, blockedReason: null,
    activeRunId: null, pendingResumeToken: null, ...row, sessionMetadata: metadata,
  };
  if (row.archivedAt) Object.assign(metadata, { archivedAt: row.archivedAt, archiveBatchId: row.archiveBatchId });
  delete session.archivedAt;
  delete session.archiveBatchId;
  session.createdAt ??= session.updatedAt;
  if (interruptedStatuses.has(String(session.status))) session.status = 'paused';
  // A migrated process cannot retain execution ownership in the new host.
  session.activeRunId = null;
  return session;
}

export function nativeProjection(item: SessionBundle) {
  const session = nativeSession(item);
  const runs = (item.tables.agent_runtime_runs ?? []).map(row => nativeRow('agent_runtime_runs', row))
    .sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
  const metadata = session.sessionMetadata as Row;
  return {
    session, run: runs.at(-1) ?? null, cursor: 0, liveChunks: [], completedStepIds: [],
    queuedInputs: metadata.inputQueue ?? [], forceInjectItemId: metadata.inputForceInjectId ?? null,
    queueRevision: 0, pendingQueueInput: null,
    control: {
      permissions: (item.tables.agent_runtime_permissions ?? []).map(row => nativeRow('agent_runtime_permissions', row)),
      interactions: (item.tables.agent_runtime_interactions ?? []).map(row => nativeRow('agent_runtime_interactions', row)),
      runtimeControl: null, processLeases: [],
    },
  };
}

export function nativeEntities(item: SessionBundle): Array<{ kind: string; value: Row }> {
  return Object.entries(historyTables).flatMap(([table, [kind]]) =>
    (item.tables[table] ?? []).map(row => ({ kind, value: nativeRow(table, row) })),
  );
}

export function nativeReplay(item: SessionBundle) {
  const session = nativeSession(item);
  const state = Object.fromEntries(['status', 'activeRunId', 'pendingResumeToken', 'blockedReason', 'updatedAt'].map(key => [key, session[key]]));
  return (item.tables.agent_runtime_stream_records ?? []).slice(-1024).map(row => {
    const saved = decode(row.chunk_json) as { chunk?: Row } & Row;
    const chunk = { ...(saved.chunk ?? saved) };
    if (row.run_id && !chunk.runId) chunk.runId = row.run_id;
    return { kind: String(chunk.type), payload: Array.from(Buffer.from(JSON.stringify({ schema: 1, chunk, state }))) };
  });
}

export const mapLegacyHistoryRow = nativeRow;
