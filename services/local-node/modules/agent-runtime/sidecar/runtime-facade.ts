import { decodeUiSnapshot, type RuntimeRecordState } from '../../../../../packages/runtime-protocol/stream.js';
import { RuntimeSidecarClient, RuntimeSidecarError } from './sidecar-client.js';
import { createHash } from 'node:crypto';
import type { AcceptedRuntimeInput } from '../run-admission.js';
import type { AgentRun, AgentSession, AgentRunStreamChunk, AgentRunStep, AgentRuntimeMessage, RuntimeEvent, ToolCallRecord } from '../contracts.js';
import { agentRuntimeStore } from '../session-store.js';
import { logger } from '../../../infrastructure/runtime/logger.js';
import { AgentRuntimeError } from '../runtime-errors.js';

export type RuntimeSidecarAdmissionMode = 'disabled' | 'shadow';
export type RuntimeSidecarStreamMode = 'disabled' | 'shadow' | 'authoritative';

function streamMode(): RuntimeSidecarStreamMode {
  if (process.env.SYNAX_RUNTIME_SIDECAR_STREAM === 'authoritative') return 'authoritative';
  if (process.env.SYNAX_RUNTIME_SIDECAR_STREAM === 'disabled') return 'disabled';
  return process.env.SYNAX_RUNTIME_SIDECAR_STREAM === 'shadow'
    ? 'shadow'
    : process.env.SYNAX_RUNTIME_SIDECAR_SUPERVISOR === '1'
      ? 'authoritative'
      : 'disabled';
}

function admissionMode(): RuntimeSidecarAdmissionMode {
  return process.env.SYNAX_RUNTIME_SIDECAR_ADMISSION === 'shadow'
    ? 'shadow'
    : 'disabled';
}

let connection: { socketPath: string; token: string; client: RuntimeSidecarClient } | undefined;
let historyReadSequence = 0;
const historyReadRequest = (operation: string, sessionId: string) =>
  `history-read:${operation}:${sessionId}:${++historyReadSequence}`;
function makeClient(): RuntimeSidecarClient | null {
  const socketPath = process.env.SYNAX_RUNTIME_SIDECAR_SOCKET;
  const token = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
  if (!socketPath || !token) {
    connection?.client.close();
    connection = undefined;
    return null;
  }
  if (!connection || connection.socketPath !== socketPath || connection.token !== token) {
    connection?.client.close();
    connection = { socketPath, token, client: new RuntimeSidecarClient({ socketPath, token }) };
  }
  return connection.client;
}

export interface ShadowAdmissionInput {
  sessionId: string;
  run: AgentRun;
  runtime: AcceptedRuntimeInput;
}

export interface ShadowStreamInput {
  sessionId: string;
  runId: string;
  producerId: string;
  producerSequence: number;
  epoch: number;
  revision: number;
  chunks: unknown[];
  state: RuntimeRecordState;
}

export class RuntimeFacade {
  constructor(
    private readonly clientFactory: () => RuntimeSidecarClient | null = makeClient,
    private readonly mode: () => RuntimeSidecarAdmissionMode = admissionMode,
  ) {}

  streamMode(): RuntimeSidecarStreamMode {
    return streamMode();
  }

  enabled(): boolean {
    return this.mode() !== 'disabled' && this.clientFactory() !== null;
  }

  /** Admission is awaited before starting provider/tool execution. */
  async admitExecution(input: ShadowAdmissionInput): Promise<void> {
    const authoritative = streamMode() === 'authoritative';
    if (!authoritative && this.mode() !== 'shadow' && streamMode() !== 'shadow') return;
    const client = this.clientFactory();
    if (!client) {
      if (authoritative) throw new Error('Runtime sidecar client is not configured.');
      return;
    }
    try {
      if (authoritative) await this.ensureUiProjection(input.sessionId);
      let admission: Awaited<ReturnType<RuntimeSidecarClient['admitRun']>>;
      for (let attempt = 0; ; attempt++) {
        const state = await client.snapshot(input.sessionId);
        try {
          admission = await client.admitRun({ sessionId: input.sessionId, requestId: input.runtime.requestId,
            bodyHash: input.runtime.inputHash, runId: input.run.id, epoch: state.epoch, revision: state.revision, queueItem: input.runtime.queueItem });
          break;
        } catch (error) {
          if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
        }
      }
      if (admission.runId !== input.run.id) throw new Error('Runtime admission returned a different run identity.');
      if (authoritative && input.run.status === 'queued') {
        for (let attempt = 0; ; attempt++) {
          const fence = await client.snapshot(input.sessionId);
          if (fence.activeRunId !== input.run.id || fence.epoch !== admission.epoch) throw new Error('Runtime activation fence changed.');
          try {
            const activated = await client.activateRun({ requestId: `${input.runtime.requestId}:activate`, sessionId: input.sessionId,
              epoch: fence.epoch, revision: fence.revision, run: input.run });
            if (activated.activeRunId !== input.run.id || activated.epoch !== admission.epoch) throw new Error('Runtime activation returned an invalid run fence.');
            break;
          } catch (error) {
            if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
          }
        }
      }
      const current = await client.snapshot(input.sessionId);
      if (current.activeRunId !== input.run.id || current.epoch !== admission.epoch)
        throw new Error('Cannot relaunch a completed or superseded run.');
    } catch (error) {
      if (authoritative) throw error;
      logger.warn({ sessionId: input.sessionId, runId: input.run.id, error }, '[runtime-sidecar] shadow admission failed');
    }
  }

  async finishExecution(sessionId: string, run: AgentRun): Promise<void> {
    const authoritative = streamMode() === 'authoritative';
    if (!authoritative && this.mode() !== 'shadow' && streamMode() !== 'shadow') return;
    const status = run.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'interrupted' && status !== 'blocked') return;
    const client = this.clientFactory();
    if (!client) {
      if (authoritative) throw new Error('Runtime sidecar client is not configured.');
      return;
    }
    try {
      for (let attempt = 0; ; attempt++) {
        const state = await client.snapshot(sessionId);
        try { await client.finishRun({ sessionId, runId: run.id, requestId: `finish:${run.id}`, status, epoch: state.epoch, revision: state.revision, run }); break; }
        catch (error) { if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error; }
      }
      try {
        await this.persistRunHistory(run);
      } catch (error) {
        logger.warn({ sessionId, runId: run.id, error: error instanceof Error ? error.message : String(error) }, '[runtime-sidecar] terminal run history persistence failed');
        throw error;
      }
      await this.persistSessionHistory(sessionId);
    } catch (error) {
      if (authoritative) throw error;
      logger.warn({ sessionId, runId: run.id, error }, '[runtime-sidecar] shadow completion failed');
    }
  }

  /** Seed only an empty Rust session during cutover. Existing projections never read SQL. */
  async ensureUiProjection(sessionId: string): Promise<void> {
    await this.uiSnapshotAuthoritative(sessionId);
  }

  async queueMutation(input: {
    sessionId: string; requestId: string;
    operation: 'enqueue' | 'remove' | 'move' | 'force' | 'clear_force' | 'consume' | 'ack_consume'; payload?: unknown;
  }): Promise<Uint8Array | null> {
    if (streamMode() !== 'authoritative') return null;
    await this.ensureUiProjection(input.sessionId);
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    for (let attempt = 0; ; attempt++) {
      const snapshot = await client.snapshot(input.sessionId);
      try { return await client.queueMutation({ ...input, epoch: snapshot.epoch, revision: snapshot.revision, payload: input.payload ?? null }); }
      catch (error) {
        // No write occurred on revision conflict; retry the same semantic command against fresh state.
        if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
      }
    }
  }
  async queueSnapshot(sessionId: string): Promise<unknown> {
    if (streamMode() !== 'authoritative') throw new Error('Runtime sidecar queue is not authoritative.');
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    try { return JSON.parse(Buffer.from(await client.queueRead(sessionId)).toString('utf8')); }
    catch (error) {
      if (!(error instanceof RuntimeSidecarError) || error.code !== 'PROJECTION_MISSING') throw error;
      await this.ensureUiProjection(sessionId);
      return JSON.parse(Buffer.from(await client.queueRead(sessionId)).toString('utf8'));
    }
  }

  async controlState(sessionId: string): Promise<unknown> {
    if (streamMode() !== 'authoritative') throw new Error('Runtime sidecar controls are not authoritative.');
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    await this.ensureUiProjection(sessionId);
    for (let attempt = 0; ; attempt++) {
      const snapshot = await client.snapshot(sessionId);
      try {
        const result = await client.controlCommand({
          sessionId,
          requestId: `control-read:${sessionId}:${snapshot.epoch}:${snapshot.revision}`,
          epoch: snapshot.epoch,
          revision: snapshot.revision,
          operation: 'read',
        });
        return JSON.parse(Buffer.from(result.stateJson).toString('utf8'));
      } catch (error) {
        if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
      }
    }
  }

  async controlCommand(input: {
    sessionId: string;
    requestId: string;
    operation: string;
    payload?: unknown;
  }): Promise<unknown> {
    if (streamMode() !== 'authoritative') return null;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    await this.ensureUiProjection(input.sessionId);
    for (let attempt = 0; ; attempt++) {
      const snapshot = await client.snapshot(input.sessionId);
      try {
        const result = await client.controlCommand({
          ...input,
          epoch: snapshot.epoch,
          revision: snapshot.revision,
        });
        return JSON.parse(Buffer.from(result.stateJson).toString('utf8'));
      } catch (error) {
        if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
      }
    }
  }

  async sessionPatch(sessionId: string, requestId: string, patch: Record<string, unknown>): Promise<unknown> {
    await this.controlCommand({ sessionId, requestId, operation: 'session_patch', payload: { patch } });
    return (await this.uiSnapshotAuthoritative(sessionId)).session;
  }

  async historyCommand(input: {
    sessionId: string;
    requestId: string;
    operation: string;
    payload?: unknown;
  }): Promise<unknown> {
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    let bytes: Uint8Array;
    bytes = await client.historyCommand(input);
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  }

  async persistRunHistory(run: unknown & { id?: string; sessionId?: string }): Promise<void> {
    const client = this.clientFactory() as (RuntimeSidecarClient & { historyCommand?: unknown }) | null;
    if (!client || typeof client.historyCommand !== 'function') return;
    const sessionId = typeof run.sessionId === 'string' ? run.sessionId : undefined;
    const runId = typeof run.id === 'string' ? run.id : undefined;
    if (!sessionId || !runId) return;
    await this.historyCommand({
      sessionId,
      requestId: `history-run:${runId}:${createHash('sha256').update(JSON.stringify(run)).digest('hex')}`,
      operation: 'put_object',
      payload: { kind: 'runtime.run', value: run },
    });
  }

  async listRunHistory(sessionId: string): Promise<unknown[]> {
    const state = await this.historyCommand({
      sessionId,
      requestId: historyReadRequest('list-runs', sessionId),
      operation: 'list_runs',
      payload: {},
    }) as { items?: unknown[] };
    return state.items ?? [];
  }

  async persistSessionHistory(sessionId: string): Promise<void> {
    const client = this.clientFactory() as (RuntimeSidecarClient & { historyCommand?: unknown }) | null;
    if (!client || typeof client.historyCommand !== 'function') return;
    const messages = agentRuntimeStore.listMessages(sessionId);
    const runs = agentRuntimeStore.listRuns(sessionId);
    const tools = agentRuntimeStore.listToolCalls(sessionId);
    const events = agentRuntimeStore.listEvents(sessionId);
    const steps = runs.flatMap(run => agentRuntimeStore.listRunSteps(run.id));
    const parts = steps.flatMap(step => agentRuntimeStore.listRunParts(step.id));
    const objects = [
      ...messages.map(value => ({ kind: 'runtime.message', value })),
      ...runs.map(value => ({ kind: 'runtime.run', value })),
      ...steps.map(value => ({ kind: 'runtime.step', value })),
      ...parts.map(value => ({ kind: 'runtime.part', value })),
      ...tools.map(value => ({ kind: 'runtime.tool_call', value })),
      ...events.map(value => ({ kind: 'runtime.event', value })),
    ];
    const objectIds: string[] = [];
    for (let index = 0; index < objects.length; index++) {
      const object = objects[index];
      const id = typeof (object.value as { id?: unknown }).id === 'string'
        ? String((object.value as { id: string }).id)
        : createHash('sha256').update(JSON.stringify(object.value)).digest('hex');
      const contentHash = createHash('sha256').update(JSON.stringify(object.value)).digest('hex');
      try {
        const result = await this.historyCommand({
          sessionId,
          requestId: `history:${sessionId}:${object.kind}:${id}:${contentHash}`,
          operation: 'put_object',
          payload: object,
        });
        if (typeof (result as { objectId?: unknown }).objectId === 'string')
          objectIds.push((result as { objectId: string }).objectId);
      } catch (error) {
        logger.warn({ sessionId, kind: object.kind, id, error: error instanceof Error ? error.message : String(error) }, '[runtime-sidecar] history object persistence failed');
        throw error;
      }
    }
    if (!objectIds.length) return;

    // Keep the immutable object graph reachable. A flat root with thousands of
    // refs would eventually hit the object budget, so build bounded fan-in
    // root chunks before switching the session head.
    let refs = objectIds;
    let chunk = 0;
    while (refs.length > 256) {
      const next: string[] = [];
      for (let offset = 0; offset < refs.length; offset += 256) {
        const group = refs.slice(offset, offset + 256);
        const result = await this.historyCommand({
          sessionId,
          requestId: `history-root-chunk:${sessionId}:${chunk++}:${createHash('sha256').update(group.join('\0')).digest('hex')}`,
          operation: 'put_object',
          payload: {
            kind: 'runtime.session.root.chunk',
            value: { sessionId, count: group.length },
            refs: group,
          },
        });
        if (typeof (result as { objectId?: unknown }).objectId !== 'string') throw new Error('runtime-history root chunk did not return an object id');
        next.push((result as { objectId: string }).objectId);
      }
      refs = next;
    }
    const rootResult = await this.historyCommand({
      sessionId,
      requestId: `history-root:${sessionId}:${createHash('sha256').update(refs.join('\0')).digest('hex')}`,
      operation: 'put_object',
      payload: {
        kind: 'runtime.session.root',
        value: { sessionId, objectCount: objectIds.length, updatedAt: new Date().toISOString() },
        refs,
      },
    }) as { objectId?: string };
    if (!rootResult.objectId) throw new Error('runtime-history root did not return an object id');
    for (let attempt = 0; ; attempt++) {
      const head = await this.historyHead(sessionId);
      try {
        await this.historyCommand({
          sessionId,
          requestId: `history-head-switch:${sessionId}:${rootResult.objectId}:${head.revision}`,
          operation: 'head_switch',
          payload: { objectId: rootResult.objectId, expectedRevision: head.revision },
        });
        break;
      } catch (error) {
        if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
      }
    }
  }

  async listMessageHistory(sessionId: string): Promise<unknown[]> {
    const state = await this.historyCommand({
      sessionId,
      requestId: historyReadRequest('list-messages', sessionId),
      operation: 'list_messages',
      payload: {},
    }) as { items?: unknown[] };
    return state.items ?? [];
  }

  async listSessionProjection(): Promise<unknown[]> {
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    const bytes = await client.sessionList();
    const state = JSON.parse(Buffer.from(bytes).toString('utf8')) as { items?: unknown[] };
    return state.items ?? [];
  }

  async importUiProjection(sessionId: string, snapshot: unknown): Promise<unknown> {
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    const bytes = await client.importProjection(sessionId, new TextEncoder().encode(JSON.stringify(snapshot)));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async listHistoryObjects(sessionId: string, operation: 'list_runs' | 'list_messages' | 'list_steps' | 'list_parts' | 'list_tool_calls' | 'list_events'): Promise<unknown[]> {
    const state = await this.historyCommand({ sessionId, requestId: historyReadRequest(operation, sessionId), operation, payload: {} }) as { items?: unknown[] };
    return state.items ?? [];
  }

  private async historyHead(sessionId: string): Promise<{ revision: number; objectId?: string }> {
    return await this.historyCommand({
      sessionId,
      requestId: historyReadRequest('head', sessionId),
      operation: 'head_read',
      payload: {},
    }) as { revision: number; objectId?: string };
  }

  private orderedHistory<T>(items: T[]): T[] {
    return [...items].sort((left, right) => {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      const leftSequence = Number(leftRecord.sequence ?? leftRecord.index ?? Number.NaN);
      const rightSequence = Number(rightRecord.sequence ?? rightRecord.index ?? Number.NaN);
      if (Number.isSafeInteger(leftSequence) && Number.isSafeInteger(rightSequence) && leftSequence !== rightSequence)
        return leftSequence - rightSequence;
      const leftTime = String(leftRecord.createdAt ?? leftRecord.startedAt ?? leftRecord.timestamp ?? '');
      const rightTime = String(rightRecord.createdAt ?? rightRecord.startedAt ?? rightRecord.timestamp ?? '');
      return leftTime.localeCompare(rightTime) || String(leftRecord.id ?? '').localeCompare(String(rightRecord.id ?? ''));
    });
  }

  private encodeHistoryCursor(sessionId: string, revision: number, before: number): string {
    return Buffer.from(JSON.stringify({ sessionId, revision, before })).toString('base64url');
  }

  private decodeHistoryCursor(sessionId: string, revision: number, cursor: string | undefined): number | undefined {
    if (!cursor) return undefined;
    try {
      if (cursor.length > 2048) throw new Error('cursor too long');
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { sessionId?: unknown; revision?: unknown; before?: unknown };
      if (value.sessionId !== sessionId || value.revision !== revision || !Number.isSafeInteger(value.before) || Number(value.before) < 0)
        throw new Error('cursor does not match the current history revision');
      return Number(value.before);
    } catch {
      throw new AgentRuntimeError('Conversation changed. Refresh history.', 'HISTORY_STALE', 409);
    }
  }

  async historyWindowAuthoritative(sessionId: string, cursor?: string): Promise<{
    messages: AgentRuntimeMessage[];
    runs: AgentRun[];
    steps: AgentRunStep[];
    toolCalls: ToolCallRecord[];
    events: RuntimeEvent[];
    permissions: unknown[];
    historyWindow: {
      revision: number;
      epoch: number;
      cursor?: string;
      olderCursor?: string;
      hasEarlier: boolean;
      latest: boolean;
      detailsTruncated: boolean;
    };
  }> {
    const [head, hot, messagesRaw, runsRaw, stepsRaw, toolsRaw, eventsRaw] = await Promise.all([
      this.historyHead(sessionId),
      this.snapshotAuthoritative(sessionId),
      this.listHistoryObjects(sessionId, 'list_messages'),
      this.listHistoryObjects(sessionId, 'list_runs'),
      this.listHistoryObjects(sessionId, 'list_steps'),
      this.listHistoryObjects(sessionId, 'list_tool_calls'),
      this.listHistoryObjects(sessionId, 'list_events'),
    ]);
    const revision = Number.isSafeInteger(head.revision) ? head.revision : 0;
    const before = this.decodeHistoryCursor(sessionId, revision, cursor) ?? messagesRaw.length;
    if (before > messagesRaw.length) throw new AgentRuntimeError('Conversation changed. Refresh history.', 'HISTORY_STALE', 409);
    const messages = this.orderedHistory(messagesRaw as AgentRuntimeMessage[]);
    const pageStart = Math.max(0, before - 24);
    const pageMessages = messages.slice(pageStart, before);
    const stepIds = new Set(pageMessages.map(message => message.stepId).filter((id): id is string => Boolean(id)));
    const runIds = new Set(pageMessages.map(message => message.runId).filter((id): id is string => Boolean(id)));
    const steps = this.orderedHistory((stepsRaw as AgentRunStep[]).filter(step => stepIds.has(step.id) || runIds.has(step.runId))).slice(-48);
    for (const step of steps) runIds.add(step.runId);
    const runs = this.orderedHistory((runsRaw as AgentRun[]).filter(run => runIds.has(run.id))).slice(-48);
    const relatedStepIds = new Set(steps.map(step => step.id));
    const toolCalls = this.orderedHistory((toolsRaw as ToolCallRecord[]).filter(tool => tool.stepId && relatedStepIds.has(tool.stepId))).slice(-96);
    const events = cursor ? [] : this.orderedHistory(eventsRaw as RuntimeEvent[]).slice(-32);
    let permissions: unknown[] = [];
    if (!cursor) {
      try { permissions = ((await this.controlState(sessionId) as { permissions?: unknown[] }).permissions ?? []).slice(-32); }
      catch { permissions = []; }
    }
    const epoch = hot?.epoch ?? 0;
    return {
      messages: pageMessages,
      runs,
      steps,
      toolCalls,
      events,
      permissions,
      historyWindow: {
        revision,
        epoch,
        cursor,
        olderCursor: pageStart > 0 ? this.encodeHistoryCursor(sessionId, revision, pageStart) : undefined,
        hasEarlier: pageStart > 0,
        latest: !cursor,
        detailsTruncated: false,
      },
    };
  }

  async historyTimelineAuthoritative(sessionId: string, before = Number.MAX_SAFE_INTEGER): Promise<{ items: AgentRuntimeMessage[]; next?: number; epoch: number }> {
    const [hot, messagesRaw] = await Promise.all([
      this.snapshotAuthoritative(sessionId),
      this.listHistoryObjects(sessionId, 'list_messages'),
    ]);
    const messages = this.orderedHistory(messagesRaw as AgentRuntimeMessage[])
      .filter(message => message.role === 'user' || message.role === 'assistant');
    const numeric = messages.map((message, index) => ({ message, order: Number((message as unknown as { sequence?: unknown }).sequence ?? index + 1) }));
    const filtered = numeric.filter(item => item.order < before);
    const page = filtered.slice(-256);
    const next = filtered.length > page.length ? page[0]?.order : undefined;
    return { items: page.map(item => item.message), next, epoch: hot?.epoch ?? 0 };
  }

  async messageContentAuthoritative(sessionId: string, messageId: string, cursor = 0, expectedRevision?: number): Promise<{ text: string; next?: number; revision: number }> {
    const head = await this.historyHead(sessionId);
    if (expectedRevision !== undefined && expectedRevision !== head.revision) throw new AgentRuntimeError('Conversation changed.', 'HISTORY_STALE', 409);
    if (cursor > 0 && expectedRevision === undefined) throw new AgentRuntimeError('Content continuation requires the original revision.', 'HISTORY_STALE', 409);
    const messages = this.orderedHistory(await this.listHistoryObjects(sessionId, 'list_messages') as AgentRuntimeMessage[]);
    const message = messages.find(item => item.id === messageId);
    if (!message) throw new AgentRuntimeError('Message missing.', 'NOT_FOUND', 404);
    const text = typeof message.content === 'string' ? message.content : '';
    const pageSize = 8192;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length) throw new AgentRuntimeError('Invalid content cursor.', 'INVALID_INPUT', 400);
    return { text: text.slice(cursor, cursor + pageSize), next: cursor + pageSize < text.length ? cursor + pageSize : undefined, revision: head.revision };
  }

  async uiSnapshotAuthoritative(sessionId: string): Promise<{
    session: AgentSession; run: AgentRun | null; cursor: number;
    liveChunks: AgentRunStreamChunk[]; completedStepIds: string[]; queuedInputs?: unknown[]; forceInjectItemId?: string | null;
  }> {
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    let bytes: Uint8Array;
    try { bytes = await client.uiSnapshot(sessionId); }
    catch (error) {
      if (!(error instanceof RuntimeSidecarError) || error.code !== 'PROJECTION_MISSING') throw error;
      const { agentRuntimeStore } = await import('../session-store.js');
      const session = agentRuntimeStore.getSession(sessionId);
      if (agentRuntimeStore.listRuns(sessionId).some(run => run.status !== 'queued')) {
        throw new RuntimeSidecarError({ type: 'error', code: 'PROJECTION_MIGRATION_REQUIRED',
          message: 'Existing executed runs require offline projection migration.' });
      }
      // Seed is create-if-absent, serialized by the session actor. It cannot overwrite
      // live data; pre-existing runs without a projection require offline migration.
      bytes = await client.seedUi(sessionId, Buffer.from(JSON.stringify(session)));
    }
    return decodeUiSnapshot(bytes, sessionId);
  }

  async uiTicket(sessionId: string, clientId: string) {
    if (streamMode() !== 'authoritative') return null;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar discovery is not ready.');
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = Number(process.env.SYNAX_RUNTIME_SIDECAR_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Runtime sidecar discovery is not ready.');
      const ticket = await client.issueTicket(sessionId, clientId);
      if (Number(process.env.SYNAX_RUNTIME_SIDECAR_PORT) !== port) continue;
      return { url: `ws://127.0.0.1:${port}/runtime`, token: ticket.token,
        expiresAtMs: ticket.expiresAtMs, clientId, sessionId, protocol: 'synax.runtime.v2' as const };
    }
    throw new Error('Runtime sidecar restarted during ticket issuance.');
  }

  async streamFence(sessionId: string, runId: string): Promise<{ epoch: number; revision: number }> {
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    const snapshot = await client.snapshot(sessionId);
    if (snapshot.activeRunId !== runId) throw new Error('Runtime stream run is not active.');
    return { epoch: snapshot.epoch, revision: snapshot.revision };
  }

  async authoritativeRecordState(sessionId: string): Promise<RuntimeRecordState> {
    const snapshot = await this.uiSnapshotAuthoritative(sessionId);
    const session = snapshot.session;
    return {
      status: session.status,
      activeRunId: session.activeRunId,
      pendingResumeToken: session.pendingResumeToken,
      blockedReason: session.blockedReason,
      updatedAt: session.updatedAt,
    };
  }

  async appendStreamAuthoritative(input: ShadowStreamInput): Promise<void> {
    if (streamMode() !== 'authoritative') return;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    await client.appendStream({
      sessionId: input.sessionId,
      runId: input.runId,
      producerId: input.producerId,
      producerSequence: input.producerSequence,
      epoch: input.epoch,
      revision: input.revision,
      durability: 'group_commit',
      events: input.chunks.map((chunk) => ({
        kind: typeof chunk === 'object' && chunk && 'type' in chunk
          ? String((chunk as { type: unknown }).type)
          : 'runtime_chunk',
        payload: Buffer.from(JSON.stringify({ schema: 1, chunk, state: input.state })),
      })),
    });
  }

  async replayAuthoritative(
    sessionId: string,
    after: number,
    runId?: string,
  ): Promise<Array<{ sequence: number; runId: string; payload: Uint8Array }>> {
    if (streamMode() !== 'authoritative') return [];
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    const response = await client.replay(sessionId, after);
    return response.events
      .filter((event) => !runId || event.runId === runId)
      .map((event) => ({ sequence: event.sequence, runId: event.runId, payload: event.payload }));
  }

  async snapshotAuthoritative(sessionId: string) {
    if (streamMode() !== 'authoritative') return null;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    return await client.snapshot(sessionId);
  }

  async shadowAppendStream(input: ShadowStreamInput): Promise<void> {
    if (streamMode() !== 'shadow') return;
    const client = this.clientFactory();
    if (!client) return;
    try {
      await client.appendStream({
        sessionId: input.sessionId,
        runId: input.runId,
        producerId: input.producerId,
        producerSequence: input.producerSequence,
        epoch: input.epoch,
        revision: input.revision,
        durability: 'group_commit',
        events: input.chunks.map((chunk) => ({
          kind: typeof chunk === 'object' && chunk && 'type' in chunk
            ? String((chunk as { type: unknown }).type)
            : 'runtime_chunk',
          payload: Buffer.from(JSON.stringify({ schema: 1, chunk, state: input.state })),
        })),
      });
    } catch (error) {
      const details = error instanceof RuntimeSidecarError
        ? { code: error.code, expected: error.expected, actual: error.actual }
        : {};
      logger.warn(
        { ...details, sessionId: input.sessionId, runId: input.runId, producerSequence: input.producerSequence, error },
        '[runtime-sidecar] shadow stream append failed',
      );
      throw error;
    }
  }
}

export const runtimeFacade = new RuntimeFacade();
