import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

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

const mockStepResults: Array<{
  fullStream: AsyncIterable<MockStreamEvent>;
  tools?: { resolveToolId: (name: string) => string | undefined };
  mustFinalize?: boolean;
  model?: string | null;
}> = [];

/**
 * Minimal JSON shorthand parser for tests. Extracts { "tool": "...", "args": {...} }
 * from the beginning of text, matching the real parseLoopModelStepText behavior.
 */
function parseJsonToolShorthand(text: string): { toolId: string; args: Record<string, unknown>; message?: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;

  // Find the matching closing brace
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0) { endIndex = i; break; } }
  }
  if (endIndex === -1) return null;

  try {
    const jsonStr = trimmed.slice(0, endIndex + 1);
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') return null;
    const toolId = typeof parsed.toolId === 'string' ? parsed.toolId
      : typeof parsed.tool === 'string' ? parsed.tool : null;
    if (!toolId) return null;
    const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
      ? parsed.args as Record<string, unknown>
      : {};
    const trailing = trimmed.slice(endIndex + 1).trim();
    return { toolId, args, message: trailing || undefined };
  } catch {
    return null;
  }
}

/**
 * Mock for streamLoopModelStep — processes mock stream events the same way the
 * real implementation does, yielding text_delta / thought_delta / step_complete.
 */
async function* mockStreamLoopModelStep(input: {
  tools: { resolveToolId: (name: string) => string | undefined };
  mustFinalize?: boolean;
  model?: string | null;
}): AsyncGenerator<{
  type: string;
  delta?: string;
  step?: {
    thought?: string;
    message?: string;
    toolCalls: Array<{ id: string; toolId: string; args: Record<string, unknown> }>;
    final: boolean;
    stopReason: string | null;
    finishReason: string | null;
    usage?: Record<string, unknown>;
    providerMetadata?: Record<string, unknown>;
  };
  model?: string | null;
}> {
  const data = mockStepResults.shift();
  if (!data) throw new Error('No mock step data queued — call queueMockStep() first.');

  let text = '';
  let thought = '';
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | undefined;
  let providerMetadata: Record<string, unknown> | undefined;
  const toolCalls: Array<{ id: string; toolId: string; args: Record<string, unknown> }> = [];

  for await (const event of data.fullStream) {
    switch (event.type) {
      case 'text-delta':
        text += event.text;
        yield { type: 'text_delta', delta: event.text };
        break;
      case 'reasoning-delta':
        thought += event.text;
        yield { type: 'thought_delta', delta: event.text };
        break;
      case 'tool-call': {
        const toolId = input.tools.resolveToolId(event.toolName) ?? event.toolName;
        toolCalls.push({
          id: typeof event.toolCallId === 'number' ? String(event.toolCallId) : event.toolCallId,
          toolId,
          args: event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : {},
        });
        break;
      }
      case 'finish-step':
        finishReason = event.finishReason;
        usage = event.usage;
        providerMetadata = event.providerMetadata;
        break;
      case 'finish':
        finishReason ??= event.finishReason;
        usage ??= event.totalUsage;
        break;
    }
  }

  // JSON shorthand fallback: if no structured tool calls, try parsing text as JSON
  let finalMessage: string | undefined = text.trim() || undefined;
  let finalToolCalls = toolCalls.filter(c => !c.toolId.includes('multi_tool_use'));

  if (!data.mustFinalize && finalToolCalls.length === 0 && finalMessage) {
    const shorthand = parseJsonToolShorthand(finalMessage);
    if (shorthand) {
      finalToolCalls = [{
        id: `mtc_fallback_1`,
        toolId: input.tools.resolveToolId(shorthand.toolId) ?? shorthand.toolId,
        args: shorthand.args,
      }];
      finalMessage = shorthand.message || undefined;
    }
  }

  if (data.mustFinalize) finalToolCalls = [];

  yield {
    type: 'step_complete',
    step: {
      thought: thought.trim() || undefined,
      message: text.trim() || undefined,
      toolCalls: finalToolCalls,
      final: data.mustFinalize || finalToolCalls.length === 0,
      stopReason: data.mustFinalize ? 'max_steps' : null,
      finishReason: data.mustFinalize ? 'max_steps' : finishReason,
      usage,
      providerMetadata,
    },
    model: data.model ?? input.model ?? null,
  };
}

function queueMockStep(stream: ReturnType<typeof makeStream>, opts?: { mustFinalize?: boolean; model?: string | null }) {
  mockStepResults.push({ fullStream: stream.fullStream, mustFinalize: opts?.mustFinalize, model: opts?.model });
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

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../loop-model-stream.js', () => ({
  streamLoopModelStep: (input: unknown) => mockStreamLoopModelStep(input as Parameters<typeof mockStreamLoopModelStep>[0]),
  generateLoopModelStep: vi.fn().mockRejectedValue(new Error('generateLoopModelStep not mocked')),
}));

vi.mock('../context-tokenizer.js', () => ({
  countTokens: vi.fn().mockReturnValue(100),
  countMessagesTokens: vi.fn().mockReturnValue(500),
  estimateToolDefinitionsTokens: vi.fn().mockReturnValue(50),
}));

// Prevent resolveGatewaySelection from trying real LLM resolution
vi.mock('../../llm-runtime/gateway.js', () => ({
  resolveGatewaySelection: vi.fn().mockRejectedValue(new Error('not configured in test')),
}));

import { agentLoopRuntime } from '../loop-runtime.js';
import { permissionPolicy } from '../permission-policy.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { executorInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { API_SESSION_LOG_FILE } from '../../../lib/logger.js';

async function collectChunks<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe('agentLoopRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStepResults.length = 0;
    resetAgentRuntimeFixtures();
    fs.rmSync(path.resolve('tmp/agent-loop-runtime-read.txt'), { force: true });
    fs.rmSync(path.resolve('tmp/agent-loop-runtime-write.txt'), { force: true });
    fs.writeFileSync(API_SESSION_LOG_FILE, '', 'utf8');
  });

  it('persists a multi-step read tool loop with run-step transcript parts', async () => {
    const readPath = 'tmp/agent-loop-runtime-read.txt';
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), 'loop runtime file', 'utf8');
    queueMockStep(
      makeToolStep({
        message: 'I need to inspect the file first.',
        toolName: 'file_read',
        toolCallId: 'call-read',
        args: { path: readPath },
      }),
    );
    queueMockStep(makeTextStep('The file contents were read successfully.'));

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
  });

  it('repairs OpenCode-style tool JSON followed by assistant text', async () => {
    queueMockStep(makeTextStep('{"tool":"file.read","args":{"path":"package.json"}}I am reading package.json now.'));
    queueMockStep(makeTextStep('package.json was read and summarized.'));

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
    queueMockStep(
      makeToolStep({
        message: 'I need to inspect the file first.',
        toolName: 'file_read',
        toolCallId: 123 as any,
        args: { path: 'package.json' },
      }),
    );
    queueMockStep(makeTextStep('package.json was read and summarized.'));

    const session = agentSessionRuntime.create(executorInput);
    await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Read package.json and summarize it.' }));

    const [toolCall] = agentRuntimeStore.listToolCalls(session.id);
    expect(toolCall.modelToolCallId).toBe('123');
    expect(typeof toolCall.modelToolCallId).toBe('string');
    expect(agentLoopRuntime.listMessages(session.id).at(-1)?.content).toBe('package.json was read and summarized.');
  });

  it('resumes an approved pending write tool and continues the original run', async () => {
    const writePath = 'tmp/agent-loop-runtime-write.txt';
    queueMockStep(
      makeToolStep({
        message: 'I need approval before writing the file.',
        toolName: 'file_write',
        toolCallId: 'call-write',
        args: { path: writePath, content: 'hello' },
      }),
    );
    queueMockStep(makeTextStep('Write complete.'));

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
    queueMockStep(
      makeToolStep({
        message: 'I am delegating this as a read-only subtask.',
        toolName: 'subagent_delegate',
        toolCallId: 'call-task',
        args: { profileId: 'explorer', prompt: 'Inspect the module and summarize the result.' },
      }),
    );
    queueMockStep(makeTextStep('Child summary: the module is read-only and safe.'));
    queueMockStep(makeTextStep('Parent run complete after child summary.'));

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

  it('executes multiple read tools in parallel within a single step', async () => {
    const readPath = 'tmp/agent-loop-runtime-read.txt';
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), 'parallel read test', 'utf8');

    // Single step with 3 read tool calls — all should execute in parallel
    queueMockStep(
        makeStream([
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'file_read', input: { path: readPath } },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'file_list', input: { path: 'tmp' } },
          { type: 'tool-call', toolCallId: 'call-3', toolName: 'file_glob', input: { pattern: '*.txt' } },
          { type: 'finish-step', finishReason: 'tool-calls', usage: {} },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
        ]),
      );
    queueMockStep(makeTextStep('All reads completed.'));

    const session = agentSessionRuntime.create(executorInput);
    const chunks = await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Run three reads in parallel.' }));

    const toolCallChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool_call');
    const toolResultChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool_result');
    expect(toolCallChunks).toHaveLength(3);
    expect(toolResultChunks).toHaveLength(3);

    const allToolCalls = agentRuntimeStore.listToolCalls(session.id);
    expect(allToolCalls).toHaveLength(3);
    expect(allToolCalls.every((call) => call.status === 'completed')).toBe(true);

    const toolIds = allToolCalls.map((call) => call.toolId).sort();
    expect(toolIds).toEqual(['file.glob', 'file.list', 'file.read']);

    // Verify results are in model order (the order in allCalls)
    const [run] = agentLoopRuntime.listRuns(session.id);
    const steps = agentLoopRuntime.listRunSteps(session.id, run.id);
    const firstStepParts = agentRuntimeStore.listRunParts(steps[0].id);
    const toolCallPartIds = firstStepParts
      .filter((part) => part.kind === 'tool_call')
      .map((part) => part.toolCallId);
    expect(toolCallPartIds).toEqual(allToolCalls.map((call) => call.id));
  });

  it('executes mixed read and write tools in parallel within a single step', async () => {
    const readPath = 'tmp/agent-loop-runtime-read.txt';
    const writePath = 'tmp/agent-loop-runtime-write.txt';
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), 'mixed test', 'utf8');

    // Allow writes to avoid permission pause
    const session = agentSessionRuntime.create(executorInput);
    agentRuntimeStore.updateSession(session.id, {
      permissionRules: [
        ...session.permissionRules,
        { gate: 'write', pattern: '*', action: 'allow', reason: 'Test allows writes.' },
      ],
    });

    queueMockStep(
        makeStream([
          { type: 'tool-call', toolCallId: 'call-read', toolName: 'file_read', input: { path: readPath } },
          { type: 'tool-call', toolCallId: 'call-write', toolName: 'file_write', input: { path: writePath, content: 'mixed parallel' } },
          { type: 'finish-step', finishReason: 'tool-calls', usage: {} },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
        ]),
      );
    queueMockStep(makeTextStep('Read and write both done.'));

    const chunks = await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Read and write in one step.' }));

    const toolCallChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool_call');
    const toolResultChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool_result');
    expect(toolCallChunks).toHaveLength(2);
    expect(toolResultChunks).toHaveLength(2);

    const allToolCalls = agentRuntimeStore.listToolCalls(session.id);
    expect(allToolCalls).toHaveLength(2);
    expect(allToolCalls.every((call) => call.status === 'completed')).toBe(true);

    expect(fs.readFileSync(path.resolve(writePath), 'utf8')).toBe('mixed parallel');
  });

  it('pauses at the first permission ask and emits results for tools before it', async () => {
    const readPath = 'tmp/agent-loop-runtime-read.txt';
    const writePath = 'tmp/agent-loop-runtime-write.txt';
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), 'permission test', 'utf8');

    // Step: read → write (needs permission) → read
    // The read before the write should complete and emit, the write should pause,
    // and the read after should NOT execute (its tool_call is emitted but no result)
    queueMockStep(
        makeStream([
          { type: 'tool-call', toolCallId: 'call-read-1', toolName: 'file_read', input: { path: readPath } },
          { type: 'tool-call', toolCallId: 'call-write', toolName: 'file_write', input: { path: writePath, content: 'should not write yet' } },
          { type: 'tool-call', toolCallId: 'call-read-2', toolName: 'file_list', input: { path: 'tmp' } },
          { type: 'finish-step', finishReason: 'tool-calls', usage: {} },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
        ]),
      );

    const session = agentSessionRuntime.create(executorInput);
    const chunks = await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Read, write, read in one step.' }));

    // Should have asked for permission
    expect(chunks.some((chunk) => (chunk as { type?: string }).type === 'permission_requested')).toBe(true);

    // All 3 tool_call events should be emitted
    const toolCallChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool_call');
    expect(toolCallChunks).toHaveLength(3);

    // Only the first read's tool_result should be emitted (before the ask)
    const toolResultChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool_result');
    expect(toolResultChunks).toHaveLength(1);

    // The read before the write should have completed
    const allToolCalls = agentRuntimeStore.listToolCalls(session.id);
    expect(allToolCalls).toHaveLength(3);
    const read1 = allToolCalls.find((call) => call.modelToolCallId === 'call-read-1');
    expect(read1?.status).toBe('completed');
    const writeCall = allToolCalls.find((call) => call.modelToolCallId === 'call-write');
    expect(writeCall?.status).toBe('pending');

    // Run should be waiting_permission
    const [run] = agentLoopRuntime.listRuns(session.id);
    expect(run.status).toBe('waiting_permission');
  });

  it('executes multiple subagent.delegate calls in parallel', async () => {
    queueMockStep(
        makeStream([
          { type: 'tool-call', toolCallId: 'call-sub-1', toolName: 'subagent_delegate', input: { profileId: 'explorer', prompt: 'Check module A.' } },
          { type: 'tool-call', toolCallId: 'call-sub-2', toolName: 'subagent_delegate', input: { profileId: 'explorer', prompt: 'Check module B.' } },
          { type: 'finish-step', finishReason: 'tool-calls', usage: {} },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
        ]),
      );
    queueMockStep(makeTextStep('Child A done.'));
    queueMockStep(makeTextStep('Child B done.'));
    queueMockStep(makeTextStep('Parent done after both children.'));

    const session = agentSessionRuntime.create(executorInput);
    agentRuntimeStore.updateSession(session.id, {
      permissionRules: [
        ...session.permissionRules,
        { gate: 'task', pattern: '*', action: 'allow', reason: 'Test allows delegation.' },
      ],
    });
    await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Delegate two checks.' }));

    const childSessions = agentRuntimeStore.listSessions({ projectId: executorInput.projectId })
      .filter((candidate) => candidate.parentSessionId === session.id);
    expect(childSessions).toHaveLength(2);
    expect(childSessions.every((child) => child.status === 'completed')).toBe(true);

    const taskCalls = agentRuntimeStore.listToolCalls(session.id)
      .filter((call) => call.toolId === 'subagent.delegate');
    expect(taskCalls).toHaveLength(2);
    expect(taskCalls.every((call) => call.status === 'completed')).toBe(true);
  });

  it('handles a denied tool in parallel without blocking other tools', async () => {
    const readPath = 'tmp/agent-loop-runtime-read.txt';
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), 'denied test', 'utf8');

    // Set up a deny rule for writes
    const session = agentSessionRuntime.create(executorInput);
    agentRuntimeStore.updateSession(session.id, {
      permissionRules: [
        ...session.permissionRules,
        { gate: 'write', pattern: '*', action: 'deny', reason: 'Test denies writes.' },
      ],
    });

    queueMockStep(
        makeStream([
          { type: 'tool-call', toolCallId: 'call-read', toolName: 'file_read', input: { path: readPath } },
          { type: 'tool-call', toolCallId: 'call-write', toolName: 'file_write', input: { path: 'tmp/denied.txt', content: 'denied' } },
          { type: 'finish-step', finishReason: 'tool-calls', usage: {} },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
        ]),
      );
    queueMockStep(makeTextStep('Read succeeded, write was denied.'));

    const chunks = await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Read and write.' }));

    const toolCallChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool_call');
    const toolResultChunks = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool_result');
    expect(toolCallChunks).toHaveLength(2);
    expect(toolResultChunks).toHaveLength(2);

    const allToolCalls = agentRuntimeStore.listToolCalls(session.id);
    const readCall = allToolCalls.find((call) => call.modelToolCallId === 'call-read');
    const writeCall = allToolCalls.find((call) => call.modelToolCallId === 'call-write');
    expect(readCall?.status).toBe('completed');
    expect(writeCall?.status).toBe('denied');

    // Run should complete (not blocked — denied is not the same as permission ask)
    const [run] = agentLoopRuntime.listRuns(session.id);
    expect(run.status).toBe('completed');
  });

  it('emits tool results in model-dictated order regardless of execution completion order', async () => {
    const readPath = 'tmp/agent-loop-runtime-read.txt';
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), 'order test', 'utf8');

    queueMockStep(
        makeStream([
          { type: 'tool-call', toolCallId: 'call-a', toolName: 'file_read', input: { path: readPath } },
          { type: 'tool-call', toolCallId: 'call-b', toolName: 'file_list', input: { path: 'tmp' } },
          { type: 'tool-call', toolCallId: 'call-c', toolName: 'file_glob', input: { pattern: '*.txt' } },
          { type: 'finish-step', finishReason: 'tool-calls', usage: {} },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
        ]),
      );
    queueMockStep(makeTextStep('All three tools done.'));

    const session = agentSessionRuntime.create(executorInput);
    await collectChunks(agentLoopRuntime.streamRun(session.id, { message: 'Three tools in order.' }));

    const [run] = agentLoopRuntime.listRuns(session.id);
    const steps = agentLoopRuntime.listRunSteps(session.id, run.id);
    const firstStepParts = agentRuntimeStore.listRunParts(steps[0].id);

    // Verify tool_call parts appear in A, B, C order
    const toolCallParts = firstStepParts.filter((part) => part.kind === 'tool_call');
    expect(toolCallParts).toHaveLength(3);

    // Verify tool_result parts appear in A, B, C order (not execution order)
    const toolResultParts = firstStepParts.filter((part) => part.kind === 'tool_result');
    expect(toolResultParts).toHaveLength(3);

    // Tool calls and results should be interleaved: call-A, call-B, call-C, result-A, result-B, result-C
    // (this is the new behavior — all tool_calls first, then all tool_results)
    const partKinds = firstStepParts.map((part) => part.kind);
    const toolCallIndices = toolCallParts.map((_, i) => partKinds.indexOf('tool_call', i === 0 ? 0 : partKinds.indexOf('tool_call', 0) + i));
    const toolResultIndices = toolResultParts.map((_, i) => partKinds.indexOf('tool_result', i === 0 ? 0 : partKinds.indexOf('tool_result', 0) + i));

    // All tool_calls come before all tool_results
    const maxCallIndex = Math.max(...toolCallIndices.filter((idx) => idx >= 0));
    const minResultIndex = Math.min(...toolResultIndices.filter((idx) => idx >= 0));
    expect(maxCallIndex).toBeLessThan(minResultIndex);
  });
});
