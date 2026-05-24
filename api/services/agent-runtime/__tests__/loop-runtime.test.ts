import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateGatewayStream = vi.fn();

vi.mock('../../llm-runtime/stream.js', () => ({
  createGatewayStream: (...args: unknown[]) => mockCreateGatewayStream(...args),
}));

import { agentLoopRuntime } from '../loop-runtime.js';
import { permissionPolicy } from '../permission-policy.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { executorInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { API_SESSION_LOG_FILE } from '../../../lib/logger.js';

type MockStreamEvent =
  | { type: 'text-delta'; text: string; id?: string }
  | { type: 'reasoning-delta'; text: string; id?: string }
  | { type: 'tool-call'; toolCallId: string | number; toolName: string; input: unknown }
  | { type: 'finish-step'; finishReason: string; usage?: Record<string, unknown>; providerMetadata?: Record<string, unknown> }
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
  toolCallId: string | number;
  args: Record<string, unknown>;
}): ReturnType<typeof makeStream> {
  return makeStream([
    ...(input.message ? [{ type: 'text-delta' as const, id: 'txt', text: input.message }] : []),
    { type: 'tool-call', toolCallId: input.toolCallId, toolName: input.toolName, input: input.args },
    { type: 'finish-step', finishReason: 'tool-calls', usage: {} },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
  ]);
}

async function collectChunks<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe('agentLoopRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentRuntimeFixtures();
    fs.rmSync(path.resolve('tmp/agent-loop-runtime-read.txt'), { force: true });
    fs.rmSync(path.resolve('tmp/agent-loop-runtime-write.txt'), { force: true });
    fs.writeFileSync(API_SESSION_LOG_FILE, '', 'utf8');
  });

  it('persists a multi-step read tool loop with run-step transcript parts', async () => {
    const readPath = 'tmp/agent-loop-runtime-read.txt';
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), 'loop runtime file', 'utf8');
    mockCreateGatewayStream
      .mockResolvedValueOnce(
        makeToolStep({
          message: 'I need to inspect the file first.',
          toolName: 'file_read',
          toolCallId: 'call-read',
          args: { path: readPath },
        }),
      )
      .mockResolvedValueOnce(makeTextStep('The file contents were read successfully.'));

    const session = agentSessionRuntime.create(executorInput);
    const chunks = await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Inspect the temp file.' }));

    expect(chunks.some((chunk) => (chunk as { type?: string }).type === 'tool_call')).toBe(true);
    expect(chunks.some((chunk) => (chunk as { type?: string }).type === 'tool_result')).toBe(true);
    expect(agentLoopRuntime.listMessages(session.id).map((message) => `${message.role}:${message.content}`)).toEqual([
      'user:Inspect the temp file.',
      'assistant:The file contents were read successfully.',
    ]);

    const [run] = agentLoopRuntime.listRuns(session.id);
    const steps = agentLoopRuntime.listRunSteps(session.id, run.id);
    expect(steps).toHaveLength(2);

    const firstStepParts = agentRuntimeStore.listRunParts(steps[0].id);
    expect(firstStepParts.map((part) => part.kind)).toEqual(['text', 'tool_call', 'tool_result']);
    const [toolCall] = agentRuntimeStore.listToolCalls(session.id);
    expect(firstStepParts.find((part) => part.kind === 'tool_call')?.toolCallId).toBe(toolCall.id);
    expect(firstStepParts.find((part) => part.kind === 'tool_result')?.toolCallId).toBe(toolCall.id);
    expect(toolCall.status).toBe('completed');

    const logText = fs.readFileSync(API_SESSION_LOG_FILE, 'utf8');
    expect(logText).toContain('[agent-runtime] run starting');
    expect(logText).toContain('[agent-runtime] tool call executed');
    expect(logText).toContain('[agent-runtime] model step completed');
    expect(mockCreateGatewayStream.mock.calls[0]?.[0].tools).toHaveProperty('file_read');

    const secondRequest = mockCreateGatewayStream.mock.calls[1]?.[0];
    expect(secondRequest?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: 'I need to inspect the file first.' }),
            expect.objectContaining({ type: 'tool-call', toolName: 'file_read' }),
          ]),
        }),
        expect.objectContaining({
          role: 'tool',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'tool-result',
              toolName: 'file_read',
              output: expect.objectContaining({ type: 'json' }),
            }),
          ]),
        }),
      ]),
    );
  });

  it('repairs OpenCode-style tool JSON followed by assistant text', async () => {
    mockCreateGatewayStream
      .mockResolvedValueOnce(makeTextStep('{"tool":"file.read","args":{"path":"package.json"}}I am reading package.json now.'))
      .mockResolvedValueOnce(makeTextStep('package.json was read and summarized.'));

    const session = agentSessionRuntime.create(executorInput);
    const chunks = await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Read package.json and summarize it.' }));

    expect(chunks.some((chunk) => (chunk as { type?: string }).type === 'tool_call')).toBe(true);
    expect(chunks.some((chunk) => (chunk as { type?: string }).type === 'tool_result')).toBe(true);

    const [toolCall] = agentRuntimeStore.listToolCalls(session.id);
    expect(toolCall.toolId).toBe('file.read');
    expect(toolCall.status).toBe('completed');
    expect(toolCall.inputRef).toEqual({ path: 'package.json' });
    expect(agentLoopRuntime.listMessages(session.id).at(-1)?.content).toBe('package.json was read and summarized.');

    expect(agentLoopRuntime.listRuns(session.id)[0]?.status).toBe('completed');
  });

  it('normalizes numeric tool call ids before reusing them in later turns', async () => {
    mockCreateGatewayStream
      .mockResolvedValueOnce(
        makeToolStep({
          message: 'I need to inspect the file first.',
          toolName: 'file_read',
          toolCallId: 123 as any,
          args: { path: 'package.json' },
        }),
      )
      .mockResolvedValueOnce(makeTextStep('package.json was read and summarized.'));

    const session = agentSessionRuntime.create(executorInput);
    await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Read package.json and summarize it.' }));

    const [toolCall] = agentRuntimeStore.listToolCalls(session.id);
    expect(toolCall.modelToolCallId).toBe('123');
    expect(typeof toolCall.modelToolCallId).toBe('string');
    const secondRequest = mockCreateGatewayStream.mock.calls[1]?.[0];
    expect(secondRequest?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'tool-call', toolCallId: '123' }),
          ]),
        }),
      ]),
    );
    expect(agentLoopRuntime.listMessages(session.id).at(-1)?.content).toBe('package.json was read and summarized.');
  });

  it('resumes an approved pending write tool and continues the original run', async () => {
    const writePath = 'tmp/agent-loop-runtime-write.txt';
    mockCreateGatewayStream
      .mockResolvedValueOnce(
        makeToolStep({
          message: 'I need approval before writing the file.',
          toolName: 'file_write',
          toolCallId: 'call-write',
          args: { path: writePath, content: 'hello' },
        }),
      )
      .mockResolvedValueOnce(makeTextStep('Write complete.'));

    const session = agentSessionRuntime.create(executorInput);
    const firstPass = await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Write the file.' }));
    expect(firstPass.some((chunk) => (chunk as { type?: string }).type === 'permission_requested')).toBe(true);

    const [permission] = permissionPolicy.list(session.id);
    permissionPolicy.reply(session.id, permission.id, 'once');
    await agentLoopRuntime.resumeRun(session.id);

    expect(fs.readFileSync(path.resolve(writePath), 'utf8')).toBe('hello');
    expect(agentLoopRuntime.listRuns(session.id)).toHaveLength(1);

    const [run] = agentLoopRuntime.listRuns(session.id);
    const steps = agentLoopRuntime.listRunSteps(session.id, run.id);
    expect(steps).toHaveLength(2);

    const firstStepParts = agentRuntimeStore.listRunParts(steps[0].id);
    expect(firstStepParts.map((part) => part.kind)).toEqual(['text', 'tool_call', 'system_note', 'tool_result']);

    const [toolCall] = agentRuntimeStore.listToolCalls(session.id);
    expect(toolCall.status).toBe('completed');
    expect(firstStepParts.find((part) => part.kind === 'tool_result')?.toolCallId).toBe(toolCall.id);
    expect(agentLoopRuntime.listMessages(session.id).at(-1)?.content).toBe('Write complete.');
  });

  it('waits for task.run child completion and injects the child summary into the parent tool result', async () => {
    mockCreateGatewayStream
      .mockResolvedValueOnce(
        makeToolStep({
          message: 'I am delegating this as a read-only subtask.',
          toolName: 'subagent_delegate',
          toolCallId: 'call-task',
          args: { profileId: 'explorer', prompt: 'Inspect the module and summarize the result.' },
        }),
      )
      .mockResolvedValueOnce(makeTextStep('Child summary: the module is read-only and safe.'))
      .mockResolvedValueOnce(makeTextStep('Parent run complete after child summary.'));

    const session = agentSessionRuntime.create(executorInput);
    agentRuntimeStore.updateSession(session.id, {
      permissionRules: [
        ...session.permissionRules,
        { gate: 'task', pattern: '*', action: 'allow', reason: 'Test allows task delegation.' },
      ],
    });
    await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Delegate a bounded check.' }));

    const childSessions = agentRuntimeStore.listSessions({ projectId: executorInput.projectId }).filter((candidate) => candidate.parentSessionId === session.id);
    expect(childSessions).toHaveLength(1);
    expect(childSessions[0]?.status).toBe('completed');
    expect(childSessions[0]?.resultSummary).toBe('Child summary: the module is read-only and safe.');

    const [taskCall] = agentRuntimeStore.listToolCalls(session.id).filter((call) => call.toolId === 'subagent.delegate');
    expect(taskCall.outputSummary).toContain(childSessions[0]!.id);
    expect(taskCall.outputSummary).toContain('Child summary: the module is read-only and safe.');
    expect((taskCall.outputRef as { childSummary?: string }).childSummary).toBe('Child summary: the module is read-only and safe.');
    expect(agentLoopRuntime.listMessages(session.id).at(-1)?.content).toBe('Parent run complete after child summary.');
  });
});
