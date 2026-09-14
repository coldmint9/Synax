import { ensureSynaxAgentRegistered } from '../../services/agent-runtime/synax/index.js';
import { getBackendAdapter } from '../../services/agent-runtime/backends/backend-registry.js';
import http, { type Server } from 'node:http';
import os from 'node:os';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunStreamChunk, StreamTurnRequest } from '../../services/agent-runtime/contracts.js';
import { agentRuntimeStore } from '../../services/agent-runtime/session-store.js';
import { activateAcceptedRun } from '../../services/agent-runtime/run-admission.js';
import { resetAgentRuntimeFixtures } from '../../services/agent-runtime/__tests__/agent-runtime-fixtures.js';
import { runCoordinator } from '../../services/agent-runtime/run-coordinator.js';
import { agentRuntimeRoutes } from '../agent-runtime.js';
const mock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../services/agent-runtime/backend-execution.js', () => ({ executeBackendSession: mock.execute }));
vi.mock('../../services/llm-runtime/provider-check.js', () => ({ assertLlmProviderConfigured: vi.fn() }));
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
  resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered(); executionSignal = undefined; mock.execute.mockReset();
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
    agentRuntimeStore.updateSession(sessionId, { status: finished.status, activeRunId: null });
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
  it('shows stopping and refuses policy changes until cleanup is confirmed', async () => {
    const id = await createSession('synax');
    await request('POST', `/sessions/${id}/runs`, { message: 'Run', requestId: 'stopping-policy' });
    let confirm!: () => void;
    const gate = new Promise<void>(resolve => { confirm = resolve; });
    const interrupt = vi.spyOn(getBackendAdapter('native'), 'interrupt').mockImplementation(async () => gate);
    const stopping = request('POST', `/sessions/${id}/cancel`);
    try {
      await vi.waitFor(async () => {
        const state = JSON.parse((await request('GET', `/sessions/${id}/snapshot`)).body);
        expect(state.session.status).toBe('stopping');
      });
      expect((await request('PATCH', `/sessions/${id}/mode`, { mode: 'plan' })).status).toBe(409);
      expect((await request('PATCH', `/sessions/${id}/permissions`, { permissionTier: 'unrestricted' })).status).toBe(409);
      expect((await request('POST', `/sessions/${id}/interactions/pending/reply`, { revision: 1, action: 'submit', answers: {} })).status).toBe(409);
    } finally { confirm(); await stopping; interrupt.mockRestore(); }
    expect(JSON.parse((await request('GET', `/sessions/${id}/snapshot`)).body).session.status).toBe('interrupted');
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
          if (!text.includes('run_started')) return;
          const sequence = Number(/id: (\d+)/.exec(text)?.[1]);
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
    expect(a.status).toBe(202); expect(b.status).toBe(202);
    expect(JSON.parse(a.body).run.id).toBe(JSON.parse(b.body).run.id);
    expect(mock.execute).toHaveBeenCalledTimes(1);
    const stop = await request('POST', `/sessions/${id}/cancel`);
    expect(stop.status).toBe(200); expect(executionSignal?.aborted).toBe(true);
    expect(runCoordinator.isActive(id)).toBe(false);
    expect(agentRuntimeStore.listMessages(id).find(message => message.metadata?.partial === true)?.content).toBe('partial output');
  });
});
