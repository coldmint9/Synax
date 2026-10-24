/**
 * First-token latency benchmark: browser send -> first rendered character.
 *
 * Scope (one row per concurrency level):
 *   - Browser: user sends from the composer, the page paints the first character
 *     of the streaming answer.
 *   - Node host: when the runtime admitted the turn, when the first upstream
 *     token arrived (Rust provider bridge -> Node), when Node emitted the first
 *     display delta on the session stream, when the run completed.
 *   - Runtime: step start -> first token and step start -> run completion.
 *
 * The model is a local deterministic OpenAI-compatible server, so the numbers
 * describe Synax's own cost (plus a fixed, subtractable provider delay), not a
 * provider's queueing behaviour. Point SYNAX_BENCH_LLM_BASE_URL at a real
 * OpenAI-compatible endpoint to measure a real model instead.
 *
 * Every session is seeded with 50 user/assistant turns (~100k prompt tokens)
 * through the same `append_entities` history channel the runtime uses.
 *
 * Usage:
 *   tsx scripts/runtime-first-token-benchmark.ts
 *   tsx scripts/runtime-first-token-benchmark.ts --levels=1,3,8 --turns=50 --sends=2
 *   tsx scripts/runtime-first-token-benchmark.ts --levels=1 --turns=3 --context-tokens=6000
 *   tsx scripts/runtime-first-token-benchmark.ts --mock-ttft=300 --mock-token-ms=20 --mock-tokens=40
 *   tsx scripts/runtime-first-token-benchmark.ts --target=dist --keep
 *
 * `--target=dist` is the default: the packaged kernel forks a session child per
 * conversation, and in `--target=source` every fork re-transpiles the TypeScript
 * graph (seconds per child), which has nothing to do with production latency.
 * Build first (`npm run build`) so `server-dist` matches the tree under test.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { getEncoding } from 'js-tiktoken';
import { chromium, type Browser, type Page } from 'playwright-core';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';
import { createWebGateway } from '../services/local-node/modules/web/web-gateway.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

type Options = {
  levels: number[];
  turns: number;
  contextTokens: number;
  sends: number;
  mockTtftMs: number;
  mockTokenMs: number;
  mockTokens: number;
  target: 'dist' | 'source';
  out: string;
  browserPath?: string;
  keep: boolean;
  kernelLog: boolean;
  sendTimeoutMs: number;
  externalBaseUrl?: string;
  externalApiKey?: string;
  externalModel?: string;
};

function readOptions(argv: string[]): Options {
  const flag = (name: string): string | undefined => {
    const inline = argv.find(arg => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const int = (name: string, fallback: number): number => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer.`);
    return value;
  };
  const levels = (flag('levels') ?? '1,3,8')
    .split(',')
    .map(value => Number(value.trim()));
  if (!levels.length || !levels.every(value => Number.isInteger(value) && value >= 1 && value <= 16))
    throw new Error('--levels must be a comma separated list of integers between 1 and 16.');
  const target = (flag('target') ?? 'dist') as Options['target'];
  if (target !== 'dist' && target !== 'source') throw new Error('--target must be "dist" or "source".');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    levels: [...new Set(levels)].sort((a, b) => a - b),
    turns: int('turns', 50),
    contextTokens: int('context-tokens', 100_000),
    sends: int('sends', 2),
    mockTtftMs: Number(flag('mock-ttft') ?? 300),
    mockTokenMs: Number(flag('mock-token-ms') ?? 20),
    mockTokens: int('mock-tokens', 40),
    target,
    out: path.resolve(ROOT, flag('out') ?? `.tmp/performance-first-token/${stamp}`),
    browserPath: flag('browser'),
    keep: argv.includes('--keep'),
    kernelLog: argv.includes('--kernel-log'),
    sendTimeoutMs: int('send-timeout', 240),
    externalBaseUrl: flag('base-url') ?? process.env.SYNAX_BENCH_LLM_BASE_URL,
    externalApiKey: flag('api-key') ?? process.env.SYNAX_BENCH_LLM_API_KEY,
    externalModel: flag('model') ?? process.env.SYNAX_BENCH_LLM_MODEL,
  };
}

// ---------------------------------------------------------------------------
// Fixtures: a deterministic 50-turn conversation of ~100k prompt tokens
// ---------------------------------------------------------------------------

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
const at = (index: number) => new Date(BASE_TIME + index * 1000).toISOString();
const WORDS =
  'runtime session message history projection snapshot stream provider latency token context workspace cache index payload boundary schedule queue admission checkpoint '.split(
    ' ',
  );

/** Deterministic prose whose token count is tuned once to the requested size. */
function proseFactory(targetTokens: number): (seed: number) => string {
  const encoder = getEncoding('o200k_base');
  const build = (words: number, seed: number): string => {
    const parts: string[] = [`Turn ${seed}.`];
    let index = seed * 7;
    while (parts.join(' ').split(' ').length < words) {
      parts.push(WORDS[index % WORDS.length]!);
      index += 3;
    }
    parts.push(`Marker ${seed}.`);
    return parts.join(' ');
  };
  let words = Math.max(8, Math.round(targetTokens * 1.25));
  for (let attempt = 0; attempt < 6; attempt++) {
    const tokens = encoder.encode(build(words, 1)).length;
    if (Math.abs(tokens - targetTokens) <= Math.max(2, targetTokens * 0.02)) break;
    words = Math.max(8, Math.round((words * targetTokens) / Math.max(1, tokens)));
  }
  return (seed: number) => build(words, seed);
}

function makeSession(id: string, projectId: string, turns: number, tokens: number): Record<string, unknown> {
  return {
    id,
    runtimeRecoveryRequired: false,
    projectId,
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: 'synax',
    status: 'completed',
    title: `Benchmark ${turns} turns / ${Math.round(tokens / 1000)}k context`,
    prompt: 'First-token latency benchmark fixture.',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    reasoningEffort: null,
    permissionRules: [],
    createdAt: at(0),
    updatedAt: at(turns * 2),
    completedAt: at(turns * 2),
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    mcpServerIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    // The sessions page only offers the composer for interactive workspace
    // sessions; the runtime records the same marker when it creates one.
    sessionMetadata: { source: 'session-page' },
  };
}

/** One completed turn: user message, run, step, assistant part and event. */
function conversationEntities(
  sessionId: string,
  turns: number,
  prose: (seed: number) => string,
): Array<{ kind: string; value: Record<string, unknown> }> {
  const objects: Array<{ kind: string; value: Record<string, unknown> }> = [];
  for (let turn = 0; turn < turns; turn++) {
    const runId = `run-${sessionId}-${turn}`;
    const stepId = `step-${sessionId}-${turn}`;
    const userIndex = turn * 2;
    const replyIndex = userIndex + 1;
    const userText = prose(turn * 2 + 1);
    const assistantText = prose(turn * 2 + 2);
    objects.push({
      kind: 'runtime.message',
      value: {
        id: `msg-${sessionId}-${userIndex}`,
        sessionId,
        runId,
        stepId: null,
        role: 'user',
        content: userText,
        contentParts: [{ type: 'text', text: userText }],
        metadata: {},
        sequence: userIndex,
        createdAt: at(userIndex),
      },
    });
    objects.push({
      kind: 'runtime.run',
      value: {
        id: runId,
        sessionId,
        status: 'completed',
        startedAt: at(replyIndex),
        completedAt: at(replyIndex),
        triggerMessageId: `msg-${sessionId}-${userIndex}`,
        currentStep: 1,
        stopReason: 'completed',
        model: 'benchmark-model',
        metadata: {},
      },
    });
    objects.push({
      kind: 'runtime.step',
      value: {
        id: stepId,
        runId,
        sessionId,
        index: 1,
        status: 'completed',
        model: 'benchmark-model',
        startedAt: at(replyIndex),
        completedAt: at(replyIndex),
        finishReason: 'stop',
        metadata: {},
      },
    });
    objects.push({
      kind: 'runtime.part',
      value: {
        id: `part-${sessionId}-${turn}`,
        runId,
        stepId,
        sessionId,
        kind: 'text',
        sequence: 1,
        content: assistantText,
        toolCallId: null,
        metadata: {},
        createdAt: at(replyIndex),
      },
    });
    objects.push({
      kind: 'runtime.message',
      value: {
        id: `msg-${sessionId}-${replyIndex}`,
        sessionId,
        runId,
        stepId,
        role: 'assistant',
        content: assistantText,
        contentParts: [{ type: 'text', text: assistantText }],
        metadata: {},
        sequence: replyIndex,
        createdAt: at(replyIndex),
      },
    });
    objects.push({
      kind: 'runtime.event',
      value: {
        id: `evt-${sessionId}-${turn}`,
        sessionId,
        runId,
        type: 'run_completed',
        timestamp: at(replyIndex),
        visibility: 'user_visible',
        summary: 'Run completed.',
        payload: {},
      },
    });
  }
  return objects;
}

async function seedSession(
  client: RuntimeSidecarClient,
  input: { sessionId: string; projectId: string; turns: number; tokens: number },
): Promise<{ entities: number; bytes: number; tokens: number }> {
  const encoder = getEncoding('o200k_base');
  const perMessage = Math.max(24, Math.round(input.tokens / (input.turns * 2)));
  const prose = proseFactory(perMessage);
  const session = makeSession(input.sessionId, input.projectId, input.turns, input.tokens);
  await client.seedUi(input.sessionId, Buffer.from(JSON.stringify(session)));
  const objects = conversationEntities(input.sessionId, input.turns, prose);
  let tokens = encoder.encode(JSON.stringify(session)).length;
  for (const object of objects) {
    if (object.kind !== 'runtime.message') continue;
    const value = object.value as { content?: unknown };
    if (typeof value.content === 'string') tokens += encoder.encode(value.content).length;
  }
  let batch: typeof objects = [];
  let batchBytes = 0;
  let bytes = Buffer.byteLength(JSON.stringify(session));
  let request = 0;
  const flush = async () => {
    if (!batch.length) return;
    const payload = { objects: batch };
    await client.historyCommand({
      sessionId: input.sessionId,
      requestId: `seed-${input.sessionId}-${++request}`,
      operation: 'append_entities',
      payload,
    });
    bytes += Buffer.byteLength(JSON.stringify(payload));
    batch = [];
    batchBytes = 0;
  };
  for (const object of objects) {
    const size = Buffer.byteLength(JSON.stringify(object)) + 2;
    // The sidecar accepts 1..=256 entities per append command.
    if (batch.length >= 256 || batchBytes + size > 512 * 1024) await flush();
    batch.push(object);
    batchBytes += size;
  }
  await flush();
  return { entities: objects.length, bytes, tokens };
}

// ---------------------------------------------------------------------------
// Deterministic provider
// ---------------------------------------------------------------------------

type ProviderCall = {
  receivedAt: number;
  firstByteAt: number;
  finishedAt: number;
  promptChars: number;
  promptTokens: number;
  messages: number;
  /** Role + leading text of each message, for fixture sanity checks. */
  preview: string;
  /** Raw request body; the turn request is identified by the sent message. */
  body: string;
};

type MockProvider = {
  baseUrl: string;
  model: string;
  apiKey: string;
  calls: ProviderCall[];
  close: () => Promise<void>;
};

function promptStats(body: string): { chars: number; tokens: number; messages: number; preview: string } {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const text = JSON.stringify(messages);
    const preview = messages
      .slice(0, 8)
      .map(message => {
        const content =
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
        return `${message.role ?? '?'}: ${content.slice(0, 90)}`;
      })
      .join(' | ');
    return {
      chars: Buffer.byteLength(text),
      tokens: getEncoding('o200k_base').encode(text).length,
      messages: messages.length,
      preview: preview.slice(0, 700),
    };
  } catch {
    return { chars: body.length, tokens: 0, messages: 0, preview: '' };
  }
}

/** Token stats are only needed for the report, never inside a measured window. */
function finalizeCall(call: ProviderCall): ProviderCall {
  if (call.messages) return call;
  const stats = promptStats(call.body);
  call.promptTokens = stats.tokens;
  call.messages = stats.messages;
  call.preview = stats.preview;
  return call;
}

async function startMockProvider(options: Options): Promise<MockProvider> {
  // Warm the tokenizer before any request is timed: the first encode would
  // otherwise block this process (and the response write) for about a second.
  void promptStats('{"messages":[]}');
  const calls: ProviderCall[] = [];
  const tokenText = 'streamed token';
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      if (!request.url?.includes('/chat/completions')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'bench-model', object: 'model' }] }));
        return;
      }
      const receivedAt = Date.now();
      const call: ProviderCall = {
        receivedAt,
        firstByteAt: 0,
        finishedAt: 0,
        promptChars: Buffer.byteLength(body),
        // Counted after the measured window; see `finalizeCall`.
        promptTokens: 0,
        messages: 0,
        preview: '',
        body,
      };
      calls.push(call);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const frame = (content: string, finish: string | null) =>
        `data: ${JSON.stringify({
          id: 'bench',
          object: 'chat.completion.chunk',
          created: 1,
          model: options.externalModel ?? 'bench-model',
          choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
        })}\n\n`;
      let sent = 0;
      const tick = () => {
        if (sent === 0) {
          call.firstByteAt = Date.now();
          response.write(frame(`${tokenText} `, null));
          sent += 1;
        } else if (sent < options.mockTokens) {
          response.write(frame(`${tokenText} `, null));
          sent += 1;
        } else {
          response.write(frame('', 'stop'));
          response.write('data: [DONE]\n\n');
          call.finishedAt = Date.now();
          response.end();
          return;
        }
        setTimeout(tick, options.mockTokenMs);
      };
      setTimeout(tick, options.mockTtftMs);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'bench-model',
    apiKey: 'bench-key',
    calls,
    close: async () => {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Kernel control
// ---------------------------------------------------------------------------

type Kernel = {
  child: ChildProcess;
  port: number;
  token: string;
  sidecarPid: number;
  baseUrl: string;
  bootMs: number;
  output: () => string;
};

function kernelCommand(target: Options['target']): { command: string; args: string[] } {
  if (target === 'source')
    return {
      command: process.execPath,
      args: ['--import', 'tsx', 'services/local-node/entrypoints/http-server.ts'],
    };
  if (!existsSync(path.join(ROOT, 'server-dist/server.cjs')))
    throw new Error('server-dist/server.cjs is missing. Run `npm run build` or pass --target=source.');
  return { command: process.execPath, args: ['server-dist/server.cjs'] };
}

async function startKernel(target: Options['target'], dataRoot: string, webPort: number, options: Options): Promise<Kernel> {
  const { command, args } = kernelCommand(target);
  const started = performance.now();
  const child = spawn(command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_ROOT: dataRoot,
      PORT: '0',
      // The gateway port is the trusted web origin for the loopback bootstrap.
      WEB_PORT: String(webPort),
      NODE_ENV: 'production',
      SYNAX_DESKTOP_SIDECAR: '1',
      LOG_LEVEL: process.env.SYNAX_BENCH_LOG_LEVEL ?? (options.kernelLog ? 'info' : 'warn'),
      SYNAX_DISABLE_CONTEXT_COMPACTION: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Kernel did not become ready.\n${buffer.slice(-4000)}`)),
      90_000,
    );
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Kernel exited before READY (${code}).\n${buffer.slice(-4000)}`));
    });
    const onData = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-400_000);
      const match = /^SYNAX_DESKTOP_READY:(\d+)$/m.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
  });
  const token = (await readFile(path.join(dataRoot, 'runtime-access-token'), 'utf8')).trim();
  const sidecarPid = Number(/"sidecarPid":\s*(\d+)/.exec(buffer)?.[1] ?? 0);
  return {
    child,
    port,
    token,
    sidecarPid,
    baseUrl: `http://127.0.0.1:${port}`,
    bootMs: performance.now() - started,
    output: () => buffer,
  };
}

async function stopKernel(kernel: Kernel): Promise<void> {
  const { child } = kernel;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const force = setTimeout(() => child.kill('SIGKILL'), 15_000);
  child.kill('SIGTERM');
  await closed;
  clearTimeout(force);
}

function parseCpuTime(value: string): number {
  const parts = value.trim().split(':').map(Number);
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return 0;
}

/** CPU seconds of the kernel process tree (Node host + per-session children). */
async function treeCpuSeconds(rootPid: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,time='], { maxBuffer: 8 * 1024 * 1024 });
    const children = new Map<number, number[]>();
    const cpu = new Map<number, number>();
    for (const line of stdout.split('\n')) {
      const [pid, ppid, time] = line.trim().split(/\s+/);
      if (!pid || !ppid || !time) continue;
      const id = Number(pid);
      cpu.set(id, parseCpuTime(time));
      const parent = Number(ppid);
      children.set(parent, [...(children.get(parent) ?? []), id]);
    }
    let total = 0;
    const stack = [rootPid];
    const seen = new Set<number>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      total += cpu.get(id) ?? 0;
      stack.push(...(children.get(id) ?? []));
    }
    return total;
  } catch {
    return 0;
  }
}

async function rssMb(pid: number): Promise<number | null> {
  if (!pid) return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) ? Number((kb / 1024).toFixed(1)) : null;
  } catch {
    return null;
  }
}

async function api(kernel: Kernel, route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${kernel.baseUrl}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${kernel.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

// ---------------------------------------------------------------------------
// Node-side observation: the same session stream the UI consumes
// ---------------------------------------------------------------------------

type NodeTimeline = {
  submitSentAt: number;
  submitAckAt: number;
  runStartedAt: number;
  stepStartedAt: number;
  waitingModelAt: number;
  firstTokenAt: number;
  firstDeltaAt: number;
  completedAt: number;
  runId: string;
};

const emptyTimeline = (): NodeTimeline => ({
  submitSentAt: 0,
  submitAckAt: 0,
  runStartedAt: 0,
  stepStartedAt: 0,
  waitingModelAt: 0,
  firstTokenAt: 0,
  firstDeltaAt: 0,
  completedAt: 0,
  runId: '',
});

/**
 * Subscribe before the send so every runtime transition is timestamped when it
 * reaches the HTTP layer, not when a poll happens to notice it. `generating` is
 * emitted by `rust-native-backend` on the first upstream text/reasoning delta,
 * which is exactly "Node received the response".
 */
class SessionSensor {
  readonly timeline = emptyTimeline();
  private readonly controller = new AbortController();
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private done = false;
  private lastSequence = 0;
  private ignoreThrough = 0;
  readonly problems: string[] = [];
  readonly recent: string[] = [];
  /** Sequence floor of everything already accounted for; new runs start above it. */
  get floor(): number {
    return this.lastSequence;
  }

  constructor(
    private readonly kernel: Kernel,
    private readonly sessionId: string,
  ) {}

  async start(): Promise<void> {
    void this.pump();
  }

  /** Reconnect like the UI does; a dropped observation stream must not silently
   * turn "no completion seen" into a fake timeout. */
  private async pump(): Promise<void> {
    while (!this.done) {
      try {
        const response = await api(
          this.kernel,
          `/api/agent-runtime/sessions/${this.sessionId}/stream?after=${this.lastSequence}`,
          { signal: this.controller.signal },
        );
        if (!response.ok) throw new Error(`stream ${response.status}`);
        this.reader = response.body!.getReader();
        await this.consume();
        if (!this.done) this.problems.push('stream ended early');
      } catch (error) {
        if (this.done) return;
        this.problems.push(`stream error: ${String(error)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  private async consume(): Promise<void> {
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const next = await this.reader!.read();
      if (next.done) return;
      pending += decoder.decode(next.value, { stream: true });
      for (;;) {
        const index = pending.indexOf('\n\n');
        if (index < 0) break;
        const frame = pending.slice(0, index);
        pending = pending.slice(index + 2);
        const dataLine = frame.split('\n').find(line => line.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === '{}') continue;
        let record: {
          sequence?: number;
          runId?: string;
          chunk?: { type?: string; execution?: { phase?: string } };
        };
        try {
          record = JSON.parse(payload);
        } catch {
          continue;
        }
        if (this.done) return;
        const sequence = Number(record.sequence ?? 0);
        if (sequence) this.lastSequence = Math.max(this.lastSequence, sequence);
        // A finished run keeps replaying buffered frames for a moment; ignore
        // everything the previous measured send already produced.
        if (sequence && sequence <= this.ignoreThrough) continue;
        const type = record.chunk?.type;
        const now = Date.now();
        if (this.recent.length < 40) this.recent.push(`${sequence}:${type}`);
        else this.recent[this.recent.length - 1] = `${sequence}:${type}`;
        const timeline = this.timeline;
        if (type === 'run_started' && !timeline.runStartedAt) {
          timeline.runStartedAt = now;
          timeline.runId = record.runId ?? '';
        }
        if (type === 'step_started' && !timeline.stepStartedAt) timeline.stepStartedAt = now;
        if (type === 'execution_status') {
          const phase = record.chunk?.execution?.phase;
          if (phase === 'waiting_model' && !timeline.waitingModelAt) timeline.waitingModelAt = now;
          if (phase === 'generating' && !timeline.firstTokenAt) timeline.firstTokenAt = now;
        }
        if (type === 'message_delta' && !timeline.firstDeltaAt) timeline.firstDeltaAt = now;
        if (type === 'run_completed' && !timeline.completedAt) timeline.completedAt = now;
      }
    }
  }

  reset(): void {
    this.ignoreThrough = this.lastSequence;
    Object.assign(this.timeline, emptyTimeline());
  }

  async waitForCompletion(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.timeline.completedAt) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  }

  async dispose(): Promise<void> {
    this.done = true;
    this.controller.abort();
    await this.reader?.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Browser client: send from the composer, timestamp the first painted character
// ---------------------------------------------------------------------------

type BrowserSend = {
  index: number;
  sendAt: number;
  deltaAt: number;
  mutationAt: number;
  paintAt: number;
  firstText: string;
  node: NodeTimeline;
  provider: ProviderCall | null;
  submitDurationMs: number | null;
};

type BrowserClient = {
  index: number;
  sessionId: string;
  browser: Browser;
  page: Page;
  sensor: SessionSensor;
  openMs: number;
  sends: BrowserSend[];
};

/**
 * Installed before the app boots: nothing here touches React, the store or the
 * transport. `sendAt` is captured in the capture phase of the real keydown, so
 * the measured window starts at the input event the user would have produced.
 */
// The probe lives in its own file: injected source must reach the page byte for
// byte, without the bundler's name-keeping helpers.
const PROBE_SOURCE = readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'first-token-probe.js'), 'utf8');

function chromePath(options: Options): string {
  if (options.browserPath) return options.browserPath;
  if (process.env.SYNAX_CHROME_PATH) return process.env.SYNAX_CHROME_PATH;
  if (process.platform === 'darwin')
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return chromium.executablePath();
}

async function openClient(input: {
  index: number;
  sessionId: string;
  projectId: string;
  origin: string;
  kernel: Kernel;
  options: Options;
}): Promise<BrowserClient> {
  const browser = await chromium.launch({
    executablePath: chromePath(input.options),
    headless: true,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  await page.addInitScript({ content: PROBE_SOURCE });
  const url = `${input.origin}/projects/${input.projectId}/sessions?session=${encodeURIComponent(input.sessionId)}`;
  const opened = performance.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  try {
    await page.locator('.workbench-shell').first().waitFor({ state: 'visible', timeout: 120_000 });
  } catch (error) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 1200)).catch(() => 'unreadable');
    await page
      .screenshot({ path: path.join(input.options.out, `debug-client-${input.index}.png`), fullPage: false })
      .catch(() => undefined);
    throw new Error(
      `Workbench did not appear: ${page.url()}\n${problems.slice(-8).join('\n')}\nBODY: ${body}\n${String(error)}`,
    );
  }
  // Ready = the seeded transcript is on screen and the composer is armed. Long
  // transcripts render incrementally, so the composer is the real gate.
  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.agent-conversation-copy').length >= 1 &&
        Boolean(document.querySelector('textarea.agent-dock-composer-input')),
      undefined,
      { timeout: 120_000 },
    );
  } catch (error) {
    const diagnostics = await page
      .evaluate(`(() => ({
        url: location.href,
        copies: document.querySelectorAll('.agent-conversation-copy').length,
        userMessages: document.querySelectorAll('.session-user-message').length,
        feedProse: document.querySelectorAll('.feed-prose').length,
        text: document.body.innerText.slice(0, 1500),
      }))()`)
      .catch(() => 'unreadable');
    await page
      .screenshot({ path: path.join(input.options.out, `debug-transcript-${input.index}.png`), fullPage: false })
      .catch(() => undefined);
    throw new Error(
      `Seeded transcript did not render: ${JSON.stringify(diagnostics)}\n${problems.slice(-8).join('\n')}\n${String(error)}`,
    );
  }
  await page.waitForFunction(() => document.visibilityState === 'visible', undefined, { timeout: 10_000 });
  const probeReady = await page.evaluate('typeof window.__bench');
  if (probeReady === 'undefined')
    throw new Error(`Page probe did not install: ${page.url()} problems=${JSON.stringify(problems.slice(-5))}`);
  const sensor = new SessionSensor(input.kernel, input.sessionId);
  await sensor.start();
  return {
    index: input.index,
    sessionId: input.sessionId,
    browser,
    page,
    sensor,
    openMs: performance.now() - opened,
    sends: [],
  };
}

// ---------------------------------------------------------------------------
// One measured send per client, all clients released on the same barrier
// ---------------------------------------------------------------------------

type SendMetrics = {
  level: number;
  client: number;
  wave: number;
  /** 浏览器：keydown -> 答案首字绘制 */
  sendToPaintMs: number;
  sendToSubmitMs: number;
  /** 服务端：发送 -> node 收到首个 token（M2 的权威口径） */
  sendToNodeFirstTokenMs: number;
  /** 浏览器：POST 发出 -> 收到 runtime 的“已收到首个 token”状态 */
  submitToGeneratingMs: number;
  sendToGeneratingMs: number;
  sendToDeltaFrameMs: number;
  deltaFrameToPaintMs: number;
  /** 服务端：请求被接收 -> run 真正开始（会话/Agent 启动） */
  submitToRunStartedMs: number;
  /** 服务端：run 开始 -> 模型 step 开始（上下文投影、工具 schema） */
  runStartToStepMs: number;
  /** runtime：step 开始 -> 供应商请求离开发起方 */
  stepToProviderRequestMs: number;
  /** runtime：供应商请求 -> node 收到首个 token（含 TTFT） */
  providerToNodeTokenMs: number;
  /** node：首个 token -> 会话流首个 display delta */
  nodeTokenToDeltaEmitMs: number;
  /** runtime：run 开始 -> 首个 token（runtime 自身首字延迟） */
  runStartToFirstTokenMs: number;
  /** runtime：run 开始 -> run 完成（持久化 run 记录） */
  runTotalMs: number;
  /** 观测流时钟与持久化记录的最大偏差，用于自检 */
  sensorLagMs: number | null;
  /** 内核自报的请求准备分段（step metadata.requestPreparationTimingsMs）。 */
  prepPhases: Record<string, number> | null;
  /** Auxiliary model calls (context checkpoint, title…) seen in the same window. */
  auxiliaryCalls: number;
  auxiliaryMaxPromptTokens: number;
  provider: {
    ttftMs: number;
    promptTokens: number;
    promptChars: number;
    messages: number;
    preview: string;
  } | null;
  firstText: string;
};

async function readProbe(page: Page): Promise<{
  sendAt: number;
  submitAt: number;
  generatingAt: number;
  deltaAt: number;
  mutationAt: number;
  paintAt: number;
  firstText: string;
}> {
  return page.evaluate(`(() => {
    const state = window.__bench || {};
    return {
      sendAt: Number(state.sendAt || 0),
      submitAt: Number(state.submitAt || 0),
      generatingAt: Number(state.generatingAt || 0),
      deltaAt: Number(state.deltaAt || 0),
      mutationAt: Number(state.mutationAt || 0),
      paintAt: Number(state.paintAt || 0),
      firstText: String(state.firstText || ''),
    };
  })()`);
}

async function sendWave(input: {
  level: number;
  wave: number;
  clients: BrowserClient[];
  options: Options;
  provider: MockProvider;
  kernel: Kernel;
  claimedCalls: Set<ProviderCall>;
  claimedCallsBefore: Set<ProviderCall>;
}): Promise<SendMetrics[]> {
  // Unique per client: the provider stub identifies each client's turn request
  // by the message it carries.
  const messageFor = (client: BrowserClient) =>
    `Benchmark wave ${input.wave + 1} client ${client.index}. Reply with one short paragraph.`;
  for (const client of input.clients) {
    const composer = client.page.locator('textarea.agent-dock-composer-input').first();
    try {
      await composer.click({ timeout: 20_000 });
    } catch (error) {
      const dump = await client.page.evaluate(`(async () => {
        const response = await fetch('/api/agent-runtime/sessions?projectId=bench-project&limit=50');
        const body = await response.json().catch(() => null);
        return {
          href: location.href,
          listStatus: response.status,
          listCount: body && body.items ? body.items.length : null,
          listTotal: body && body.totalCount,
          textareas: Array.from(document.querySelectorAll('textarea')).map(el => el.className),
          dock: Array.from(document.querySelectorAll('[class*=dock]')).map(el => el.className).slice(0, 10),
          text: document.body.innerText.slice(0, 600),
        };
      })()`).catch(error => 'unreadable ' + String(error));
      await client.page.screenshot({ path: path.join(input.options.out, `debug-composer-${client.index}.png`) }).catch(() => undefined);
      throw new Error(`Composer missing: ${JSON.stringify(dump)}\n${String(error)}`);
    }
    await composer.fill(messageFor(client));
    client.sensor.reset();
    await client.page.evaluate('window.__bench.arm()');
    await client.page.evaluate(
      `window.__bench.watchStream(${JSON.stringify(client.sessionId)}, ${client.sensor.floor})`,
    );
  }
  const startAt = Date.now() + 400;
  await Promise.all(
    input.clients.map(client =>
      client.page.evaluate(`new Promise((resolve, reject) => {
        const barrier = ${startAt};
        const tick = () => {
          if (Date.now() < barrier) return void setTimeout(tick, 1);
          const element = document.querySelector('textarea.agent-dock-composer-input');
          if (!element) return reject(new Error('Composer is missing.'));
          element.focus();
          element.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
          }));
          resolve(true);
        };
        tick();
      })`),
    ),
  );

  const probes = new Map<BrowserClient, Awaited<ReturnType<typeof readProbe>>>();
  await Promise.all(
    input.clients.map(async client => {
      // Wait inside the page: one round trip instead of a polling loop that
      // would steal CPU from the renderer and the runtime.
      await client.page.evaluate(`new Promise(resolve => {
        const deadline = Date.now() + ${input.options.sendTimeoutMs * 1000};
        const tick = () => {
          if (window.__bench.paintAt || Date.now() > deadline) return resolve(true);
          setTimeout(tick, 20);
        };
        tick();
      })`);
      const probe = await readProbe(client.page);
      probes.set(client, probe);
      const completed = await client.sensor.waitForCompletion(input.options.sendTimeoutMs * 1000);
      if (!completed)
        throw new Error(
          `Run did not complete within ${input.options.sendTimeoutMs}s (${client.sessionId}). ` +
            `probe=${JSON.stringify(probe)} timeline=${JSON.stringify(client.sensor.timeline)} problems=${JSON.stringify(client.sensor.problems)} recent=${JSON.stringify(client.sensor.recent)}`,
        );
    }),
  );

  // Pair every send with the provider request it produced. Prep time precedes
  // the call, so ordering by step start / arrival is stable within a wave.
  const ordered = [...input.clients].sort(
    (a, b) => a.sensor.timeline.stepStartedAt - b.sensor.timeline.stepStartedAt,
  );
  const unclaimed = input.provider.calls.filter(call => !input.claimedCalls.has(call));
  const pairs = new Map<BrowserClient, ProviderCall | null>();
  for (const client of ordered) {
    // The turn request is the one that carries the message this client sent;
    // auxiliary requests (context checkpoint, title, input optimization) do not.
    const call = unclaimed.find(item => item.body.includes(messageFor(client))) ?? null;
    if (call) {
      input.claimedCalls.add(call);
      unclaimed.splice(unclaimed.indexOf(call), 1);
      finalizeCall(call);
    }
    pairs.set(client, call);
  }
  const turnCalls = new Set([...pairs.values()].filter((call): call is ProviderCall => Boolean(call)));

  // Durable run/step records are the authoritative server boundaries, and they
  // share the wall clock with the browser and the provider stub.
  const authoritative = new Map<BrowserClient, { runStart: number; runEnd: number; stepStart: number }>();
  const prepByClient = new Map<BrowserClient, Record<string, number>>();
  for (const client of input.clients) {
    const runId = client.sensor.timeline.runId;
    if (!runId) continue;
    const run = (await (
      await api(input.kernel, `/api/agent-runtime/sessions/${client.sessionId}/runs/${runId}`)
    ).json()) as { startedAt?: string; completedAt?: string };
    const steps = (await (
      await api(input.kernel, `/api/agent-runtime/sessions/${client.sessionId}/runs/${runId}/steps`)
    ).json()) as {
      items?: Array<{ startedAt?: string; metadata?: { requestPreparationTimingsMs?: Record<string, number> } }>;
    };
    const prepPhases = steps.items?.[0]?.metadata?.requestPreparationTimingsMs ?? null;
    if (prepPhases) prepByClient.set(client, prepPhases);
    if (!run.startedAt || !run.completedAt) continue;
    const stepStart = Date.parse(steps.items?.[0]?.startedAt ?? '');
    authoritative.set(client, {
      runStart: Date.parse(run.startedAt),
      runEnd: Date.parse(run.completedAt),
      stepStart: Number.isFinite(stepStart) ? stepStart : Date.parse(run.startedAt),
    });
  }

  return input.clients.map(client => {
    const probe = probes.get(client)!;
    const timeline = client.sensor.timeline;
    const call_ = pairs.get(client) ?? null;
    const record = authoritative.get(client);
    const submitAt = probe.submitAt || probe.sendAt;
    const sendToPaintMs = probe.paintAt - probe.sendAt;
    if (!Number.isFinite(sendToPaintMs) || sendToPaintMs <= 0)
      throw new Error(
        `Invalid browser measurement (${client.sessionId}): send=${probe.sendAt} paint=${probe.paintAt}.`,
      );
    const windowEnd = Math.max(timeline.completedAt || 0, probe.paintAt || 0);
    const auxiliaries = input.provider.calls.filter(
      call =>
        !turnCalls.has(call) &&
        !input.claimedCallsBefore.has(call) &&
        call.receivedAt >= submitAt &&
        call.receivedAt <= windowEnd,
    );
    const runStart = record?.runStart ?? timeline.runStartedAt;
    const runEnd = record?.runEnd ?? timeline.completedAt;
    const stepStart = record?.stepStart ?? timeline.stepStartedAt;
    const metrics: SendMetrics = {
      level: input.level,
      client: client.index,
      wave: input.wave,
      sendToPaintMs,
      sendToSubmitMs: submitAt - probe.sendAt,
      sendToNodeFirstTokenMs: timeline.firstTokenAt ? timeline.firstTokenAt - probe.sendAt : 0,
      submitToGeneratingMs: probe.generatingAt ? probe.generatingAt - submitAt : 0,
      sendToGeneratingMs: probe.generatingAt ? probe.generatingAt - probe.sendAt : 0,
      sendToDeltaFrameMs: probe.deltaAt ? probe.deltaAt - probe.sendAt : 0,
      deltaFrameToPaintMs: probe.deltaAt ? probe.paintAt - probe.deltaAt : 0,
      submitToRunStartedMs: runStart - submitAt,
      runStartToStepMs: stepStart - runStart,
      stepToProviderRequestMs: call_ ? call_.receivedAt - stepStart : 0,
      providerToNodeTokenMs: call_ ? timeline.firstTokenAt - call_.receivedAt : 0,
      nodeTokenToDeltaEmitMs: timeline.firstDeltaAt - timeline.firstTokenAt,
      runStartToFirstTokenMs: timeline.firstTokenAt - runStart,
      runTotalMs: runEnd - runStart,
      sensorLagMs: record ? timeline.completedAt - runEnd : null,
      prepPhases: prepByClient.get(client) ?? null,
      auxiliaryCalls: auxiliaries.length,
      auxiliaryMaxPromptTokens: Math.max(0, ...auxiliaries.map(call => finalizeCall(call).promptTokens)),
      provider: call_
        ? {
            ttftMs: call_.firstByteAt - call_.receivedAt,
            promptTokens: call_.promptTokens,
            promptChars: call_.promptChars,
            messages: call_.messages,
            preview: call_.preview,
          }
        : null,
      firstText: probe.firstText,
    };
    client.sends.push({
      index: input.wave,
      sendAt: probe.sendAt,
      deltaAt: probe.deltaAt,
      mutationAt: probe.mutationAt,
      paintAt: probe.paintAt,
      firstText: probe.firstText,
      node: { ...timeline },
      provider: call_,
      submitDurationMs: null,
    });
    return metrics;
  });
}

// ---------------------------------------------------------------------------
// Level runner
// ---------------------------------------------------------------------------

type LevelResult = {
  level: number;
  kernelBootMs: number;
  loadAvg: number[];
  /** Average cores used by the runtime process tree during each wave. */
  waveCores: number[];
  kernelRssMb: number | null;
  sidecarRssMb: number | null;
  openMs: number[];
  sends: SendMetrics[];
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function configureProvider(kernel: Kernel, provider: MockProvider): Promise<void> {
  const response = await api(kernel, '/api/config/global', {
    method: 'PUT',
    body: JSON.stringify({
      defaultProviderId: 'openai',
      defaultApiProviderId: 'openai',
      providerConnections: {
        openai: {
          providerId: 'openai',
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          extra: { kind: 'api', apiFormat: 'openai', model: provider.model },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Provider configuration failed: ${response.status} ${await response.text()}`);
}

async function runLevel(input: {
  level: number;
  dataRoot: string;
  projectId: string;
  sessionIds: string[];
  provider: MockProvider;
  options: Options;
  claimedCalls: Set<ProviderCall>;
}): Promise<LevelResult> {
  const webPort = await freePort();
  const kernel = await startKernel(input.options.target, input.dataRoot, webPort, input.options);
  let gateway: Awaited<ReturnType<typeof createWebGateway>> | undefined;
  const clients: BrowserClient[] = [];
  try {
    await configureProvider(kernel, input.provider);
    // The seeded sessions must be visible to the same projection the UI lists.
    const listed = await api(kernel, `/api/agent-runtime/sessions?limit=100&projectId=${encodeURIComponent(input.projectId)}`);
    const listBody = (await listed.json()) as { items?: Array<{ id?: string; messageCount?: number; status?: string }> };
    const visible = new Set((listBody.items ?? []).map(item => item.id));
    const missing = input.sessionIds.filter(sessionId => !visible.has(sessionId));
    if (missing.length)
      throw new Error(
        `Seeded sessions are missing from the runtime session list: ${missing.join(', ')} (listed ${visible.size})`,
      );
    const detail = await api(kernel, `/api/agent-runtime/sessions/${input.sessionIds[0]}`);
    if (!detail.ok)
      console.log(`[bench] session detail ${detail.status}: ${(await detail.text()).slice(0, 500)}`);
    else await detail.text();
    gateway = await createWebGateway({ root: CLIENT_DIST, apiOrigin: kernel.baseUrl });
    await gateway.listen(webPort);
    const origin = `http://127.0.0.1:${webPort}`;
    for (const [index, sessionId] of input.sessionIds.entries()) {
      clients.push(
        await openClient({
          index,
          sessionId,
          projectId: input.projectId,
          origin,
          kernel,
          options: input.options,
        }),
      );
    }
    const sends: SendMetrics[] = [];
    const waveCores: number[] = [];
    for (let wave = 0; wave < input.options.sends; wave++) {
      const cpuStart = await treeCpuSeconds(kernel.child.pid!);
      const wallStart = Date.now();
      sends.push(
        ...(await sendWave({
          level: input.level,
          wave,
          clients,
          options: input.options,
          provider: input.provider,
          kernel,
          claimedCalls: input.claimedCalls,
          claimedCallsBefore: new Set(input.claimedCalls),
        })),
      );
      const cpuSeconds = (await treeCpuSeconds(kernel.child.pid!)) - cpuStart;
      waveCores.push(Number((cpuSeconds / ((Date.now() - wallStart) / 1000)).toFixed(2)));
      await sleep(750);
    }
    return {
      level: input.level,
      kernelBootMs: Number(kernel.bootMs.toFixed(1)),
      loadAvg: os.loadavg().map(value => Number(value.toFixed(2))),
      waveCores,
      kernelRssMb: await rssMb(kernel.child.pid!),
      sidecarRssMb: await rssMb(kernel.sidecarPid),
      openMs: clients.map(client => Number(client.openMs.toFixed(1))),
      sends,
    };
  } finally {
    await Promise.all(clients.map(async client => {
      await client.sensor.dispose();
      await client.browser.close().catch(() => undefined);
    }));
    await gateway?.close().catch(() => undefined);
    if (input.options.kernelLog)
      await writeFile(path.join(input.options.out, `kernel-level${input.level}.log`), kernel.output()).catch(() => undefined);
    await stopKernel(kernel);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
}

const round = (value: number | null | undefined, digits = 0): number | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

const stat = (values: number[]) => {
  const clean = values.filter(value => Number.isFinite(value) && value > 0);
  if (!clean.length) return { n: 0, p50: null, p95: null, max: null };
  return {
    n: clean.length,
    p50: round(percentile(clean, 0.5)),
    p95: round(percentile(clean, 0.95)),
    max: round(Math.max(...clean)),
  };
};

type MetricSpec = { key: keyof SendMetrics; label: string };

const METRICS: MetricSpec[] = [
  { key: 'sendToPaintMs', label: '① 前端：发送 → 首字渲染（M1 总延迟）' },
  { key: 'sendToSubmitMs', label: '② 前端：发送 → POST /runs 发出' },
  { key: 'submitToRunStartedMs', label: '③ 服务端：收到请求 → run 开始' },
  { key: 'runStartToStepMs', label: '④ runtime：run 开始 → 模型 step 开始（上下文投影）' },
  { key: 'stepToProviderRequestMs', label: '⑤ runtime：step 开始 → 供应商收到请求' },
  { key: 'providerToNodeTokenMs', label: '⑥ runtime：供应商收到请求 → node 收到首 token（含 mock TTFT）' },
  { key: 'sendToNodeFirstTokenMs', label: '⑦ 服务端：发送 → node 收到首 token（M2）' },
  { key: 'nodeTokenToDeltaEmitMs', label: '⑧ node：首 token → 首个 delta 下发（合并批次）' },
  { key: 'sendToDeltaFrameMs', label: '⑨ 前端：发送 → 收到首个 delta 帧' },
  { key: 'deltaFrameToPaintMs', label: '⑩ 前端：delta 帧 → 首字渲染' },
  { key: 'runStartToFirstTokenMs', label: '⑪ runtime：run 开始 → 首 token（M3 首字）' },
  { key: 'runTotalMs', label: '⑫ runtime：整轮总耗时' },
  { key: 'sensorLagMs', label: '自检：观测流与持久化记录的时钟偏差（应≈0）' },
];

function reportMarkdown(report: {
  environment: Record<string, unknown>;
  options: Options;
  levels: LevelResult[];
}): string {
  const lines: string[] = [];
  const cell = (value: unknown) => (value === null || value === undefined ? '–' : String(value));
  lines.push('# Synax 首字延迟基准：发送 → 首字渲染（1 / 3 / 8 并发）');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 环境');
  lines.push('');
  for (const [key, value] of Object.entries(report.environment)) lines.push(`- ${key}: ${String(value)}`);
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  lines.push(
    `- 每个会话 ${report.options.turns} 轮历史（${report.options.turns * 2} 条消息），目标上下文约 ${report.options.contextTokens} tokens；每个并发档位使用独立会话与独立内核进程。`,
  );
  lines.push(
    `- 每个虚拟用户执行 ${report.options.sends} 次发送：第 1 次为会话内首次发送，其余为同一会话的热发送。`,
  );
  lines.push('- 模型是本地确定性 OpenAI 兼容服务，TTFT 与出词节奏固定，因此数据反映的是 Synax 自身开销；`providerToNodeTokenMs` 内含该固定 TTFT。');
  lines.push('- 所有浏览器测量来自页面内 `performance.now()`：`sendAt` 取真实 keydown 捕获阶段，`paintAt` 取文本出现后的首个 `requestAnimationFrame`。');
  lines.push('- `generating` 由 `rust-native-backend` 在收到上游首个 text/reasoning delta 时发出，作为“node 收到响应”的判定点。');
  lines.push('');
  lines.push('## 结果');
  lines.push('');
  for (const level of report.levels) {
    const first = level.sends.filter(send => send.wave === 0);
    const warm = level.sends.filter(send => send.wave === 1);
    lines.push(`### ${level.level} 并发`);
    lines.push('');
    lines.push(
      `内核启动 ${level.kernelBootMs} ms；打开 50 轮会话 p50 ${cell(stat(level.openMs).p50)} ms / p95 ${cell(
        stat(level.openMs).p95,
      )} ms；内核 RSS ${cell(level.kernelRssMb)} MB + sidecar ${cell(level.sidecarRssMb)} MB；发送期间 runtime 进程树占用 ${level.waveCores.join(
        ' / ',
      )} 核（10 核机器）；等级结束时 1/5/15 分钟负载 ${level.loadAvg.join(' / ')}。`,
    );
    lines.push('');
    lines.push('| 指标 | 首轮 p50 | 首轮 p95 | 首轮 max | 热发送 p50 | 热发送 p95 | 样本 |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const metric of METRICS) {
      const coldStat = stat(first.map(send => Number(send[metric.key] ?? 0)));
      const warmStat = stat(warm.map(send => Number(send[metric.key] ?? 0)));
      lines.push(
        `| ${metric.label} | ${cell(coldStat.p50)} | ${cell(coldStat.p95)} | ${cell(coldStat.max)} | ${cell(
          warmStat.p50,
        )} | ${cell(warmStat.p95)} | ${coldStat.n + warmStat.n} |`,
      );
    }
    lines.push('');
    const provider = level.sends.map(send => send.provider).filter((value): value is NonNullable<typeof value> => Boolean(value));
    const auxiliary = level.sends.map(send => send.auxiliaryCalls);
    if (provider.length) {
      const tokens = stat(provider.map(item => item.promptTokens));
      lines.push(
        `本轮请求实际携带：p50 ${cell(tokens.p50)} tokens（${cell(
          round(percentile(provider.map(item => item.promptChars), 0.5), 0),
        )} bytes / ${cell(stat(provider.map(item => item.messages)).p50)} 条消息）；mock 实测 TTFT p50 ${cell(
          stat(provider.map(item => item.ttftMs)).p50,
        )} ms；同窗口内的辅助模型请求 p50 ${cell(stat(auxiliary).p50)} 次（最大提示词 p50 ${cell(
          stat(level.sends.map(send => send.auxiliaryMaxPromptTokens)).p50,
        )} tokens，属于上下文 checkpoint 维护）。`,
      );
      lines.push('');
    }
  }
  lines.push('## 明细');
  lines.push('');
  lines.push('| 并发 | 客户端 | 次数 | 发送→首字 | 发送→token 帧 | runtime 首字 | runtime 总耗时 | 首字内容 |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const level of report.levels)
    for (const send of level.sends)
      lines.push(
        `| ${level.level} | ${send.client} | ${send.wave + 1} | ${round(send.sendToPaintMs)} | ${round(
          send.sendToGeneratingMs,
        )} | ${round(send.runStartToFirstTokenMs)} | ${round(send.runTotalMs)} | ${JSON.stringify(
          send.firstText.slice(0, 18),
        )} |`,
      );
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Environment + seeding + main
// ---------------------------------------------------------------------------

async function environmentInfo(options: Options, dataRoot: string): Promise<Record<string, unknown>> {
  const version = (await readFile(path.join(ROOT, '.env.version'), 'utf8')).trim();
  const clientBuild = (await execFileAsync('stat', ['-f', '%Sm', path.join(CLIENT_DIST, 'index.html')]).catch(() => ({ stdout: 'unknown' }))).stdout.trim();
  let chrome = 'unknown';
  try {
    chrome = String(execFileSync(chromePath(options), ['--version'], { encoding: 'utf8' })).trim();
  } catch {
    chrome = chromePath(options);
  }
  let commit = 'unknown';
  try {
    commit = (await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })).stdout.trim();
  } catch {
    /* not a git checkout */
  }
  return {
    版本: version,
    提交: commit,
    平台: `${process.platform}-${process.arch}`,
    CPU: os.cpus()[0]?.model ?? 'unknown',
    核心数: os.cpus().length,
    内存GB: Math.round(os.totalmem() / 1024 ** 3),
    Node: process.version,
    浏览器: chrome,
    客户端构建: clientBuild,
    内核目标: options.target,
    数据目录: dataRoot,
    每个会话轮数: options.turns,
    目标上下文tokens: options.contextTokens,
    每次会话发送数: options.sends,
    mock配置: options.externalBaseUrl
      ? `external ${options.externalBaseUrl} / ${options.externalModel ?? 'default'}`
      : `local mock ttft=${options.mockTtftMs}ms token=${options.mockTokenMs}ms x${options.mockTokens}`,
  };
}

async function seedAll(dataRoot: string, sessions: Array<{ sessionId: string }>, options: Options): Promise<void> {
  const supervisor = new RustRuntimeSupervisor({ dataRoot });
  let client: RuntimeSidecarClient | undefined;
  try {
    await supervisor.start();
    client = new RuntimeSidecarClient({
      socketPath: supervisor.socketPath,
      token: supervisor.token,
      requestTimeoutMs: 300_000,
      retryTimeoutMs: 300_000,
    });
    for (const session of sessions) {
      const started = performance.now();
      const seeded = await seedSession(client, {
        sessionId: session.sessionId,
        projectId: 'bench-project',
        turns: options.turns,
        tokens: options.contextTokens,
      });
      console.log(
        `[seed] ${session.sessionId}: ${seeded.entities} entities, ${(seeded.bytes / 1024 / 1024).toFixed(1)} MB, ~${seeded.tokens} tokens, ${(
          performance.now() - started
        ).toFixed(0)} ms`,
      );
    }
  } finally {
    client?.close();
    await supervisor.stop();
  }
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  await mkdir(options.out, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'synax-first-token-'));
  const dataRoot = path.join(tmp, 'data');
  const repo = path.join(tmp, 'repo');
  await mkdir(dataRoot);
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(path.join(repo, 'README.md'), 'First-token benchmark workspace.\n');
  await writeFile(
    path.join(dataRoot, 'projects.json'),
    JSON.stringify({
      items: [
        {
          id: 'bench-project',
          name: 'First-token benchmark',
          status: 'healthy',
          environment: 'development',
          importState: 'ready',
          source: { kind: 'localPath', localPath: repo },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
  );

  const provider: MockProvider = options.externalBaseUrl
    ? {
        baseUrl: options.externalBaseUrl,
        model: options.externalModel ?? 'bench-model',
        apiKey: options.externalApiKey ?? 'bench-key',
        calls: [],
        close: async () => undefined,
      }
    : await startMockProvider(options);

  const levels = options.levels.map(level => ({
    level,
    sessionIds: Array.from({ length: level }, (_, index) => `ars_bench_l${level}_${index}`),
  }));
  console.log(`[bench] data root ${dataRoot}`);
  await seedAll(dataRoot, levels.flatMap(entry => entry.sessionIds.map(sessionId => ({ sessionId }))), options);
  await sleep(300);

  const claimedCalls = new Set<ProviderCall>();
  const results: LevelResult[] = [];
  try {
    for (const entry of levels) {
      console.log(`[bench] level ${entry.level} ...`);
      const result = await runLevel({
        level: entry.level,
        dataRoot,
        projectId: 'bench-project',
        sessionIds: entry.sessionIds,
        provider,
        options,
        claimedCalls,
      });
      results.push(result);
      const cold = stat(result.sends.filter(send => send.wave === 0).map(send => send.sendToPaintMs));
      const warm = stat(result.sends.filter(send => send.wave === 1).map(send => send.sendToPaintMs));
      console.log(
        `[bench] level ${entry.level}: 发送→首字 p50 ${cold.p50} ms (cold) / ${warm.p50} ms (warm), p95 ${cold.p95} / ${warm.p95}`,
      );
    }
  } finally {
    await provider.close().catch(() => undefined);
  }

  const environment = await environmentInfo(options, dataRoot);
  const report = { environment, options, levels: results };
  await writeFile(path.join(options.out, 'result.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(options.out, 'report.md'), reportMarkdown(report));
  console.log(`[bench] wrote ${path.join(options.out, 'report.md')}`);
  if (!options.keep) await rm(tmp, { recursive: true, force: true });
}

await main();
