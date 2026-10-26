import { ensureSynaxAgentRegistered } from '../../../modules/agent-runtime/synax/index.js';
import { getBackendAdapter } from '../../../modules/agent-runtime/backends/backend-registry.js';
import http, { type Server } from 'node:http';
import os from 'node:os';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunStreamChunk, StreamTurnRequest } from '../../../modules/agent-runtime/contracts.js';
import { agentRuntimeStore } from '../../../modules/agent-runtime/session-store.js';
import { activateAcceptedRun } from '../../../modules/agent-runtime/run-admission.js';
import { admitActiveFixtureRun, resetAgentRuntimeFixtures } from '../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js';
import { runCoordinator } from '../../../modules/agent-runtime/run-coordinator.js';
import { normalizeAgentSessionStatus } from '../../../modules/agent-runtime/session-projection.js';
import { agentRuntimeRoutes } from '../agent-runtime.js';
import { sessionLiveBus } from '../../../modules/agent-runtime/session-live-bus.js';
import { interactionService } from '../../../modules/agent-runtime/interaction-service.js';
import { runtimeFacade } from '../../../modules/agent-runtime/sidecar/runtime-facade.js';
const mock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../../modules/agent-runtime/backend-execution.js', () => ({ executeBackendSession: mock.execute }));
vi.mock('../../../infrastructure/llm-runtime/provider-check.js', () => ({ assertLlmProviderConfigured: vi.fn() }));
let server: Server;
let port: number;
let release: () => void;
let executionSignal: AbortSignal | undefined;

function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }, res => {
      let content = ''; res.setEncoding('utf8'); res.on('data', data => content += data);
      res.on('end', () => resolve({ status: res.statusCode!, body: content })); res.on('error', reject);
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered(); executionSignal = undefined; mock.execute.mockReset();
  const gate = new Promise<void>(resolve => { release = resolve; });
  mock.execute.mockImplementation(async function* (sessionId: string, _mode: string, input: StreamTurnRequest, signal: AbortSignal): AsyncGenerator<AgentRunStreamChunk> {
    executionSignal = signal;
    signal.addEventListener('abort', release, { once: true });
    const run = activateAcceptedRun(sessionId, input.acceptedRunId!, 'test-message', null);
    agentRuntimeStore.updateSession(sessionId, { status: 'running', activeRunId: run.id });
    const step = agentRuntimeStore.appendRunStep({ id: `step-${run.id}`, runId: run.id, sessionId, index: 1, status: 'running',
      model: null, startedAt: new Date().toISOString(), completedAt: null, finishReason: null, metadata: {} });
    yield { type: 'run_started', run }; yield { type: 'step_started', step };
    yield { type: 'message_delta', runId: run.id, stepId: step.id, delta: 'partial output' };
    await gate;
    const completedAt = new Date().toISOString();
    agentRuntimeStore.updateRunStep(step.id, { status: 'completed', completedAt });
    const finished = agentRuntimeStore.updateRun(run.id, { status: signal.aborted ? 'interrupted' : 'completed', completedAt });
    agentRuntimeStore.updateSession(sessionId, { status: normalizeAgentSessionStatus(finished.status), activeRunId: null });
    yield { type: 'run_completed', run: finished }; yield { type: 'done', sessionId, runId: run.id };
  });
  server = serve({ fetch: agentRuntimeRoutes.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await new Promise<void>(resolve => server.once('listening', resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  release(); await runCoordinator.waitForIdle();
  server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
async function createSession(profileId = 'explorer'): Promise<string> {
  const response = await request('POST', '/sessions', { projectId: 'http-fixture', profileId, prompt: 'Test', workDir: os.tmpdir() });
  expect(response.status).toBe(201); return JSON.parse(response.body).session.id;
}

describe('actual HTTP observation lifecycle with an isolated controlled backend', () => {
  it('submits through the execution projection without reloading the archived transcript', async () => {
    const id = await createSession('synax');
    const original = agentRuntimeStore.hydrateSession.bind(agentRuntimeStore);
    const hydrate = vi.spyOn(agentRuntimeStore, 'hydrateSession').mockImplementation((sessionId, refresh, options) => {
      if (!options?.execution) throw new Error('full transcript loaded before run admission');
      return original(sessionId, refresh, options);
    });
    try {
      const response = await request('POST', `/sessions/${id}/runs`, { message: 'Continue', requestId: 'bounded-admission' });
      expect(response.status, response.body).toBe(202);
      expect(hydrate).toHaveBeenCalled();
    } finally { hydrate.mockRestore(); }
  });
  it('opens a cold target session without enumerating every session or hydrating its history', async () => {
    const id = await createSession('synax');
    agentRuntimeStore.reset();
    const all = vi.spyOn(agentRuntimeStore, 'hydrateSessions').mockRejectedValue(new Error('unrelated session index blocked'));
    const history = vi.spyOn(agentRuntimeStore, 'hydrateSession').mockRejectedValue(new Error('full transcript should be lazy'));
    try {
      expect((await request('GET', '/protocol')).status).toBe(200);
      const snapshot = await request('GET', `/sessions/${id}/snapshot`);
      expect(snapshot.status, snapshot.body).toBe(200);
      const detail = await request('GET', `/sessions/${id}`);
      expect(detail.status, detail.body).toBe(200);
      expect(all).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
    } finally { all.mockRestore(); history.mockRestore(); }
  });
  it.each(['submit', 'skip', 'cancel'] as const)('accepts %s on a saved form after restart and deduplicates HTTP retries', async (action) => {
    const id = await createSession('synax');
    const run = await admitActiveFixtureRun(id, 'Ask which file');
    const now = new Date().toISOString();
    const step = agentRuntimeStore.appendRunStep({ id: `step-${run.id}`, runId: run.id, sessionId: id,
      index: 1, status: 'running', model: null, startedAt: now, completedAt: null, finishReason: null, metadata: {} });
    const call = agentRuntimeStore.appendToolCall({ id: `call-${run.id}`, sessionId: id, runId: run.id, stepId: step.id,
      modelToolCallId: 'provider-question', toolId: 'human.ask', category: 'task', mutability: 'task', argsHash: '',
      inputSummary: 'Which file?', inputRef: {}, outputSummary: null, outputRef: null, status: 'running',
      permissionDecisionId: null, startedAt: now, endedAt: null, error: null });
    const form = await interactionService.requestAuthoritative({ sessionId: id, runId: run.id, stepId: step.id,
      toolCallId: call.id, kind: 'clarification', request: { title: 'Pick a file',
        questions: [{ id: 'file', type: 'text', label: 'Which file?' }] } });
    await runtimeFacade.stopSessionAuthoritative(id, 'paused', 'App restarted');
    agentRuntimeStore.reset();
    release();
    const body = { revision: form.revision, action, ...(action === 'submit' ? { answers: { file: 'README.md' } } : {}) };
    const path = `/sessions/${id}/interactions/${form.id}/reply`;
    const results = await Promise.all([request('POST', path, body), request('POST', path, body)]);
    for (const response of results) {
      expect(response.status, response.body).toBe(200);
      expect(JSON.parse(response.body).interaction).toMatchObject({ status: action === 'cancel' ? 'cancelled' : 'answered',
        response: body, restartRequestId: `interaction-restart:${form.id}`, consumedAt: expect.any(String) });
    }
    await runCoordinator.waitForIdle();
    expect((await request('POST', path, body)).status).toBe(200);
    await runCoordinator.waitForIdle();
    expect(mock.execute).toHaveBeenCalledTimes(action === 'cancel' ? 0 : 1);
    expect(agentRuntimeStore.listRuns(id)).toHaveLength(action === 'cancel' ? 1 : 2);
    expect(agentRuntimeStore.getRun(run.id).status).toBe('interrupted');
    expect(agentRuntimeStore.getSession(id).activeRunId).toBeNull();
    const saved = JSON.parse((await request('GET', `/sessions/${id}/interactions`)).body).interactions;
    expect(saved).toEqual([expect.objectContaining({ id: form.id, consumedAt: expect.any(String), response: expect.objectContaining(body) })]);
    if (action !== 'cancel') {
      const input = mock.execute.mock.calls[0][2] as StreamTurnRequest;
      expect(input.message).toContain('Which file?');
      expect(input.message).toContain(action === 'submit' ? 'README.md' : 'Do not treat it as a refusal');
    }
  });

  it('delivers manual compaction progress, completion and failure on the unified session stream', async () => {
    const id = await createSession();
    let text = '';
    const req = http.get({ hostname: '127.0.0.1', port, path: `/sessions/${id}/stream` }, res => {
      res.setEncoding('utf8');
      res.on('data', data => { text += data; });
    });
    try {
      await vi.waitFor(() => expect(text).toContain('event: snapshot'));
      sessionLiveBus.emit(id, { type: 'context_compaction_started' });
      sessionLiveBus.emit(id, { type: 'context_compacted', stepId: '', originalTokens: 1000, compressedTokens: 200, messageCount: 4 });
      sessionLiveBus.emit(id, { type: 'context_compaction_failed', error: 'Summary timed out' });
      sessionLiveBus.emit(id, { type: 'message_delta', stepId: 'ignored', delta: 'do not duplicate journal events' });
      await vi.waitFor(() => expect(text).toContain('event: context_compaction_failed'));
      expect(text).toContain('event: context_compaction_started');
      expect(text).toContain('"compressedTokens":200');
      expect(text).toContain('Summary timed out');
      expect(text).not.toContain('do not duplicate journal events');
    } finally {
      req.destroy();
      sessionLiveBus.cleanup(id);
    }
  });

  it('delivers merge projections on both the unified and desktop auxiliary stream and releases subscriptions', async () => {
    const id = await createSession();
    for (const suffix of ['', '?auxiliary=1']) {
      let text = '';
      const baseline = sessionLiveBus.diagnostics().listeners;
      const req = http.get({ hostname: '127.0.0.1', port, path: `/sessions/${id}/stream${suffix}` }, res => {
        res.setEncoding('utf8'); res.on('data', data => { text += data; });
      });
      try {
        await vi.waitFor(() => expect(sessionLiveBus.diagnostics().listeners).toBe(baseline + 1));
        sessionLiveBus.emit(id, { type: 'conversation_git_state', taskId: 'merge', taskRevision: 2, mrVersion: 3,
          status: 'conflicted', eventSeq: 1, changedFileIds: ['f1'], changedFiles: [{ id: 'f1', path: 'app.ts', status: 'M', conflicted: false }] });
        await vi.waitFor(() => expect(text).toContain('event: conversation_git_state'));
        expect(text).toContain('"changedFileIds":["f1"]');
        expect(text).not.toContain('"content"');
      } finally { req.destroy(); }
      await vi.waitFor(() => expect(sessionLiveBus.diagnostics().listeners).toBe(baseline));
    }
    sessionLiveBus.cleanup(id);
  });

  it('keeps the public session running while shutdown is pending and refuses policy changes', async () => {
    const id = await createSession('synax');
    await request('POST', `/sessions/${id}/runs`, { message: 'Run', requestId: 'stopping-policy' });
    let confirm!: () => void;
    const gate = new Promise<void>(resolve => { confirm = resolve; });
    const interrupt = vi.spyOn(getBackendAdapter('native'), 'interrupt').mockImplementation(async () => gate);
    const stopping = request('POST', `/sessions/${id}/cancel`);
    try {
      await vi.waitFor(async () => {
        // A running snapshot can predate the cancel request now that reads no
        // longer wait behind the global session refresh. Wait for the actual fence.
        expect(runCoordinator.isStopping(id)).toBe(true);
        const state = JSON.parse((await request('GET', `/sessions/${id}/snapshot`)).body);
        expect(state.session.status).toBe('running');
      });
      expect((await request('PATCH', `/sessions/${id}/mode`, { mode: 'plan' })).status).toBe(400);
      expect((await request('PATCH', `/sessions/${id}/permissions`, { permissionTier: 'unrestricted' })).status).toBe(409);
      expect((await request('POST', `/sessions/${id}/interactions/pending/reply`, { revision: 1, action: 'submit', answers: {} })).status).toBe(409);
    } finally { confirm(); release(); await stopping; interrupt.mockRestore(); }
    const stopped = JSON.parse((await request('GET', `/sessions/${id}/snapshot`)).body);
    expect(stopped.session.status).toBe('completed');
    expect(stopped.run.status).toBe('interrupted');
    expect(stopped.session.activeRunId).toBeNull();
    expect(stopped.session.sessionMetadata.runtimeControl).toBeNull();
  });

  it('continues work after the TCP observer disconnects and replays output on reconnect', async () => {
    const id = await createSession();
    const response = await request('POST', `/sessions/${id}/runs`, { message: 'Run', requestId: 'tcp-run' });
    expect(response.status).toBe(202);
    const runId = JSON.parse(response.body).run.id as string;
    const cursor = await new Promise<number>((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: `/sessions/${id}/runs/${runId}/stream` }, res => {
        res.setEncoding('utf8'); let text = '';
        res.on('data', data => {
          text += data;
          const frames = text.split('\n\n');
          text = frames.pop() ?? '';
          const started = frames.find(frame => {
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            return data && data !== '[DONE]' && JSON.parse(data).type === 'run_started';
          });
          if (!started) return;
          const sequence = Number(/^id: (\d+)$/m.exec(started)?.[1]);
          if (!Number.isSafeInteger(sequence)) return reject(new Error('run_started lacks an event ID'));
          req.once('close', () => resolve(sequence)); res.destroy(); req.destroy();
        });
      });
      req.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); });
    });
    expect(executionSignal?.aborted).toBe(false);
    await vi.waitFor(async () => {
      const snapshot = JSON.parse((await request('GET', `/sessions/${id}/snapshot`)).body);
      expect(snapshot.liveChunks.some((chunk: { delta?: string }) => chunk.delta === 'partial output')).toBe(true);
    });
    release(); await runCoordinator.waitForIdle();
    const replay = await request('GET', `/sessions/${id}/runs/${runId}/stream?after=${cursor}`);
    expect(replay.body).not.toContain('"type":"run_started"');
    expect(replay.body).toContain('partial output'); expect(replay.body).toContain('[DONE]');
    expect(agentRuntimeStore.getRun(runId).status).toBe('completed');
    expect(mock.execute).toHaveBeenCalledTimes(1);
  });

  it('deduplicates two concurrent HTTP submissions and stops only on explicit control', async () => {
    const id = await createSession();
    const [a, b] = await Promise.all([1, 2].map(() => request('POST', `/sessions/${id}/runs`, { message: 'Run', requestId: 'duplicate' })));
    expect(a.status, a.body).toBe(202); expect(b.status, b.body).toBe(202);
    expect(JSON.parse(a.body).run.id).toBe(JSON.parse(b.body).run.id);
    await vi.waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1));
    const repeated = await request('POST', `/sessions/${id}/runs`, { message: 'Run', requestId: 'duplicate' });
    expect(repeated.status, repeated.body).toBe(202);
    expect(JSON.parse(repeated.body).run.id).toBe(JSON.parse(a.body).run.id);
    const conflict = await request('POST', `/sessions/${id}/runs`, { message: 'Different', requestId: 'duplicate' });
    expect(conflict.status, conflict.body).toBe(409);
    expect(mock.execute).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      const snapshot = JSON.parse((await request('GET', `/sessions/${id}/snapshot`)).body);
      expect(snapshot.liveChunks.some((chunk: { delta?: string }) => chunk.delta === 'partial output')).toBe(true);
    });
    const stop = await request('POST', `/sessions/${id}/cancel`);
    expect(stop.status).toBe(200); expect(executionSignal?.aborted).toBe(true);
    expect(runCoordinator.isActive(id)).toBe(false);
    const saved = await request('GET', `/sessions/${id}/messages`);
    expect(saved.status, saved.body).toBe(200);
    const messages = JSON.parse(saved.body).items as Array<{ content: string; metadata?: { partial?: boolean } }>;
    expect(messages.filter(message => message.metadata?.partial).map(message => message.content)).toEqual(['partial output']);
  });
});
