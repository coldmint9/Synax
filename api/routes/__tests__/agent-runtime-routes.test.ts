import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAgentRuntimeFixtures } from '../../services/agent-runtime/__tests__/agent-runtime-fixtures.js';

const mockCreateGatewayStream = vi.fn();

vi.mock('../../services/llm-runtime/stream.js', () => ({
  createGatewayStream: (...args: unknown[]) => mockCreateGatewayStream(...args),
}));

type MockStreamEvent =
  | { type: 'text-delta'; text: string; id?: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'finish-step'; finishReason: string; usage?: Record<string, unknown> }
  | { type: 'finish'; finishReason: string; totalUsage?: Record<string, unknown> };

function makeStream(events: MockStreamEvent[]) {
  return {
    fullStream: (async function* () {
      yield* events;
    })(),
  };
}

function makeTextStep(message: string): ReturnType<typeof makeStream> {
  return makeStream([
    { type: 'text-delta', id: 'txt', text: message },
    { type: 'finish-step', finishReason: 'stop', usage: {} },
    { type: 'finish', finishReason: 'stop', totalUsage: {} },
  ]);
}

function makeToolStep(input: {
  message?: string;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}): ReturnType<typeof makeStream> {
  return makeStream([
    ...(input.message ? [{ type: 'text-delta' as const, id: 'txt', text: input.message }] : []),
    { type: 'tool-call', toolCallId: input.toolCallId, toolName: input.toolName, input: input.args },
    { type: 'finish-step', finishReason: 'tool-calls', usage: {} },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
  ]);
}

async function waitFor(check: () => Promise<boolean>, attempts = 25, delayMs = 10): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('Timed out waiting for background runtime completion.');
}

describe('agent runtime routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentRuntimeFixtures();
    fs.rmSync(path.resolve('tmp/agent-runtime-route-resume.txt'), { force: true });
  });

  it('streams loop-runtime SSE events and persists assistant output', async () => {
    mockCreateGatewayStream.mockResolvedValueOnce(makeTextStep('hello runtime'));
    const { agentRuntimeRoutes } = await import('../agent-runtime.js');

    const created = await agentRuntimeRoutes.request('http://localhost/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        profileId: 'explorer',
        prompt: 'Explore runtime behavior',
      }),
    });
    const payload = await created.json() as { session: { id: string } };

    const stream = await agentRuntimeRoutes.request(`http://localhost/sessions/${payload.session.id}/turns/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello?' }),
    });
    const text = await stream.text();

    expect(stream.status).toBe(200);
    expect(text).toContain('run_started');
    expect(text).toContain('message_delta');
    expect(text).toContain('[DONE]');

    const messages = await agentRuntimeRoutes.request(`http://localhost/sessions/${payload.session.id}/messages`);
    const body = await messages.json() as { items: Array<{ role: string; content: string }> };
    expect(body.items.map((item) => `${item.role}:${item.content}`)).toEqual([
      'user:hello?',
      'assistant:hello runtime',
    ]);
  });

  it('auto-resumes an approved permission request without a second turn request', async () => {
    const writePath = 'tmp/agent-runtime-route-resume.txt';
    mockCreateGatewayStream
      .mockResolvedValueOnce(
        makeToolStep({
          message: 'Need approval before writing.',
          toolName: 'file_write',
          toolCallId: 'route-write',
          args: { path: writePath, content: 'route resume' },
        }),
      )
      .mockResolvedValueOnce(makeTextStep('Write finished.'));
    const { agentRuntimeRoutes } = await import('../agent-runtime.js');

    const created = await agentRuntimeRoutes.request('http://localhost/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        profileId: 'executor',
        prompt: 'Write a file',
      }),
    });
    const payload = await created.json() as { session: { id: string } };

    const firstStream = await agentRuntimeRoutes.request(`http://localhost/sessions/${payload.session.id}/turns/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Please write the file.' }),
    });
    expect(await firstStream.text()).toContain('permission_requested');

    const permissionsResponse = await agentRuntimeRoutes.request(`http://localhost/sessions/${payload.session.id}/permissions`);
    const permissionsBody = await permissionsResponse.json() as { items: Array<{ id: string }> };
    const permissionId = permissionsBody.items[0]?.id;
    expect(permissionId).toBeTruthy();

    const replyResponse = await agentRuntimeRoutes.request(
      `http://localhost/sessions/${payload.session.id}/permissions/${permissionId}/reply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: 'once' }),
      },
    );
    expect(replyResponse.status).toBe(200);

    await waitFor(async () => {
      const sessionResponse = await agentRuntimeRoutes.request(`http://localhost/sessions/${payload.session.id}`);
      const sessionBody = await sessionResponse.json() as { session: { status: string } };
      return sessionBody.session.status === 'completed';
    });

    expect(fs.readFileSync(path.resolve(writePath), 'utf8')).toBe('route resume');

    const messagesResponse = await agentRuntimeRoutes.request(`http://localhost/sessions/${payload.session.id}/messages`);
    const messagesBody = await messagesResponse.json() as { items: Array<{ role: string; content: string }> };
    expect(messagesBody.items.map((item) => `${item.role}:${item.content}`)).toContain('assistant:Write finished.');
  });
});
