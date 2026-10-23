/**
 * Where should context work live: Rust or Node?
 *
 * Measures the real cost of every step on the checkpoint/compaction path:
 * durable read, hydration, provider-prompt resolution, token counting (Rust vs
 * js-tiktoken), and the bytes each design must move over the control socket.
 * No provider requests are made; token counts are estimates, not billing.
 *
 * Run (synthetic dataset, ~4 MiB prompt):
 *   npx tsx scripts/context-boundary-benchmark.ts
 * Run against a real stored session (read-only copy):
 *   SYNAX_BENCH_SESSION_SOURCE=$HOME/.synax/v2/runtime-sidecar/jsonl/sessions/92/ars_xxx \
 *     npx tsx scripts/context-boundary-benchmark.ts
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { RustRuntimeSupervisor } from "../services/local-node/infrastructure/runtime/rust-sidecar.js";
import { runtimeClient, decode } from "../services/local-node/modules/agent-runtime/sidecar/runtime-repository.js";
import { hydrateHistoryValues } from "../services/local-node/modules/agent-runtime/sidecar/history-pages.js";
import { measureContextPrompt } from "../services/local-node/modules/agent-runtime/context-measure.js";
import { clearTokenCache, countTokens } from "../services/local-node/modules/agent-runtime/context-tokenizer.js";

const ROUNDS = Number(process.env.SYNAX_BENCH_ROUNDS ?? 3);
const SYNTHETIC_MESSAGES = Number(process.env.SYNAX_BENCH_MESSAGES ?? 120);
const SYNTHETIC_BYTES = Number(process.env.SYNAX_BENCH_MESSAGE_BYTES ?? 25_000);
const sessionSource = process.env.SYNAX_BENCH_SESSION_SOURCE;
assert(ROUNDS > 0 && SYNTHETIC_MESSAGES > 0 && SYNTHETIC_BYTES > 0, "Benchmark parameters must be positive.");

const now = () => performance.now();
const ms = (value: number) => Number(value.toFixed(2));
const mib = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(2));
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

/** Same text-accounting projection as Rust `without_attachments`. */
const MEDIA_TYPES = new Set(["image", "file", "document", "audio", "video", "attachment", "image_url", "input_image",
  "output_image", "input_file", "input_audio", "image-data", "file-data", "file-url"]);
function accounting(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if ("type" in value && MEDIA_TYPES.has(String((value as { type?: string }).type))) return { type: "retained-attachment" };
  if (Array.isArray(value)) return value.map(accounting);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, accounting(item)]));
}

/** Mirrors Rust `composition`: per-message JSON + 4, tools once, base 3. */
function nodeComposition(prompt: unknown[], systemPrompt: string, tools: unknown[]) {
  let system = 0;
  let messages = 0;
  for (const message of [{ role: "system", content: systemPrompt }, ...prompt] as Array<{ role?: string }>) {
    const tokens = countTokens(JSON.stringify(accounting(message))) + 4;
    if (message.role === "system") system += tokens;
    else messages += tokens;
  }
  const toolsTokens = countTokens(JSON.stringify(tools));
  return { system, messages, tools: toolsTokens, total: system + messages + toolsTokens + 3 };
}

const root = await mkdtemp(path.join(tmpdir(), "synax-context-boundary-"));
process.env.SYNAX_RUNTIME_TEST_MODE = "1";
const supervisor = new RustRuntimeSupervisor({ dataRoot: root });
const report: Record<string, unknown> = {};
/** Wall-clock medians move with host load; keep it in the output. */
const environment = () => ({ cpus: cpus().length, loadAverage: loadavg().map(value => Number(value.toFixed(2))) });

try {
  await supervisor.start();
  const client = runtimeClient();
  let sessionId: string;

  if (sessionSource) {
    sessionId = path.basename(sessionSource);
    const bucket = path.basename(path.dirname(sessionSource));
    const target = path.join(root, "runtime-sidecar", "jsonl", "sessions", bucket, sessionId);
    await cp(sessionSource, target, { recursive: true });
    report.dataset = { kind: "real", sessionId, source: sessionSource };
  } else {
    sessionId = `ars_${randomUUID().replaceAll("-", "")}`;
    await client.seedUi(sessionId, Buffer.from(JSON.stringify({ id: sessionId, projectId: "bench",
      status: "completed", activeRunId: null, pendingResumeToken: null, blockedReason: null,
      updatedAt: new Date().toISOString() })));
    const body = "上下文基准 ".repeat(Math.ceil(SYNTHETIC_BYTES / 21)).slice(0, SYNTHETIC_BYTES);
    const objects = Array.from({ length: SYNTHETIC_MESSAGES }, (_, index) => ({
      kind: "runtime.message",
      value: { id: `bench-${index}`, sessionId, role: index % 2 ? "assistant" : "tool", content: `${index}: ${body}` },
    }));
    for (let offset = 0; offset < objects.length; offset += 8) {
      await client.historyCommand({ sessionId, requestId: `bench-seed:${offset}`, operation: "append_entities",
        payload: { objects: objects.slice(offset, offset + 8) } });
    }
    report.dataset = { kind: "synthetic", sessionId, messages: SYNTHETIC_MESSAGES, messageBytes: SYNTHETIC_BYTES };
  }

  // --- 1. Rust reads its own durable history and counts tokens per message ---
  const headStarted = now();
  const head = decode<{ revision: number; generation: number }>(await client.historyCommand({
    sessionId, requestId: randomUUID(), operation: "context_current", payload: {},
  }));
  report.contextCurrentMs = ms(now() - headStarted);

  const readOnce = async () => {
    const started = now();
    const items: unknown[] = [];
    let cursor: unknown = null;
    let tokens = 0;
    let pages = 0;
    let responseBytes = 0;
    do {
      const page = decode<{ items: unknown[]; tokens: number; cursor: unknown; overflow: boolean }>(await client.historyCommand({
        sessionId, requestId: randomUUID(), operation: "context_prompt",
        payload: { fromRevision: 0, throughRevision: head.revision, generation: head.generation, cursor, tokenBudget: 1_000_000 },
      }));
      if (page.overflow) throw new Error("benchmark prompt overflowed the token budget");
      items.push(...page.items);
      tokens += page.tokens;
      pages++;
      responseBytes += bytesOf(page.items);
      cursor = page.cursor;
    } while (cursor);
    return { items, tokens, pages, responseBytes, elapsedMs: now() - started };
  };
  const readSamples: number[] = [];
  let read = await readOnce();
  for (let round = 0; round < ROUNDS; round++) readSamples.push((read = await readOnce()).elapsedMs);
  report.read = { pages: read.pages, messages: read.items.length, rustMessageTokens: read.tokens,
    responseMiB: mib(read.responseBytes), rustReadMs: ms(median(readSamples)),
    rustReadPerRoundMs: readSamples.map(ms) };

  // --- 2. Node expands referenced values, then resolves provider messages ---
  const hydrateStarted = now();
  const hydrated = await hydrateHistoryValues(client, sessionId, read.items, false);
  report.hydrateMs = ms(now() - hydrateStarted);
  const resolveStarted = now();
  const resolved = hydrated.map(message => {
    const stored = message as { metadata?: { rustMessage?: unknown }; role?: string; content?: string };
    return stored.metadata?.rustMessage ?? { role: stored.role, content: [{ type: "text", text: stored.content ?? "" }] };
  });
  report.resolveMs = ms(now() - resolveStarted);
  const storedBytes = bytesOf(hydrated);
  const resolvedBytes = bytesOf(resolved);
  report.payload = { storedMiB: mib(storedBytes), resolvedMiB: mib(resolvedBytes),
    duplication: Number(((storedBytes / resolvedBytes - 1) * 100).toFixed(1)) };

  // --- 3. Measurement, Rust (control socket, chunked) ---
  const systemPrompt = "You are a coding agent. ".repeat(1_600);
  const tools = [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
  const measureSamples: number[] = [];
  let groups = 0;
  let sentBytes = 0;
  let rustTotal = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const sent: number[] = [];
    const original = client.historyCommand.bind(client);
    (client as unknown as { historyCommand: typeof original }).historyCommand = async input => {
      if (input.operation === "context_measure") sent.push(bytesOf(input.payload));
      return original(input);
    };
    const started = now();
    try {
      rustTotal = await measureContextPrompt({ sessionId, systemPrompt, tools, prompt: resolved });
    } finally {
      (client as unknown as { historyCommand: typeof original }).historyCommand = original;
    }
    measureSamples.push(now() - started);
    groups = sent.length;
    sentBytes = sent.reduce((total, value) => total + value, 0);
  }
  report.measureRust = { groups, sentMiB: mib(sentBytes), tokens: rustTotal,
    ms: ms(median(measureSamples)), perRoundMs: measureSamples.map(ms) };

  // --- 4. The single-frame variant the production bug hit ---
  const payloadBytes = bytesOf({ prompt: [{ role: "system", content: systemPrompt }, ...resolved], tools });
  let singleFrame = "ok";
  try {
    await client.historyCommand({ sessionId, requestId: randomUUID(), operation: "context_measure",
      payload: { prompt: [{ role: "system", content: systemPrompt }, ...resolved], tools } });
  } catch (error) {
    singleFrame = error instanceof Error ? error.message : String(error);
  }
  report.measureSingleFrame = { payloadMiB: mib(payloadBytes), outcome: singleFrame };

  // --- 5. Measurement, Node (js-tiktoken), cold and warm ---
  clearTokenCache();
  const coldStarted = now();
  const nodeCold = nodeComposition(resolved, systemPrompt, tools);
  const nodeColdMs = now() - coldStarted;
  const warmStarted = now();
  const nodeWarm = nodeComposition(resolved, systemPrompt, tools);
  const nodeWarmMs = now() - warmStarted;
  report.measureNode = { tokens: nodeWarm.total, coldMs: ms(nodeColdMs), warmMs: ms(nodeWarmMs),
    deltaVsRust: nodeWarm.total - rustTotal,
    deltaPercent: Number((((nodeWarm.total - rustTotal) / Math.max(1, rustTotal)) * 100).toFixed(2)) };
  report.measureNodeColdTokens = nodeCold.total;

  // --- 6. Isolate Rust tokenize throughput from wire transfer + serde parse ---
  // The same bytes are sent twice: once as prompt (parsed + tokenized) and once
  // as an ignored field (parsed only, the handler never reads it).
  const probe: unknown[] = [];
  let probeBytes = 0;
  for (const message of resolved) {
    const size = bytesOf(message);
    if (probe.length && probeBytes + size > 512 * 1024) break;
    probe.push(message);
    probeBytes += size;
  }
  const timing = async (payload: unknown) => {
    const started = now();
    await client.historyCommand({ sessionId, requestId: randomUUID(), operation: "context_measure", payload });
    return now() - started;
  };
  const counted: number[] = [];
  const parsed: number[] = [];
  for (let round = 0; round < Math.max(ROUNDS, 5); round++) {
    counted.push(await timing({ prompt: probe, tools }));
    parsed.push(await timing({ prompt: [], tools: [], padding: probe }));
  }
  const parseMs = median(parsed);
  const countMs = median(counted);
  report.rustTokenizer = { probeMiB: mib(probeBytes), parseMs: ms(parseMs), parseAndCountMs: ms(countMs),
    tokenizeMs: ms(Math.max(0, countMs - parseMs)),
    tokenizeMiBPerSecond: Number((mib(probeBytes) / (Math.max(0.001, countMs - parseMs) / 1000)).toFixed(1)) };

  // --- 7. Control-channel round-trip floor ---
  const floor: number[] = [];
  for (let round = 0; round < 20; round++) {
    const started = now();
    await client.historyCommand({ sessionId, requestId: randomUUID(), operation: "context_current", payload: {} });
    floor.push(now() - started);
  }
  report.ipcFloor = { p50Ms: ms(median(floor)), p95Ms: ms(percentile(floor, 0.95)) };

  // --- 8. What a Rust-native measure would move instead ---
  const controlBytes = bytesOf(systemPrompt) + bytesOf(tools);
  report.rustNativeMeasure = { controlMiB: mib(controlBytes),
    savedMiB: mib(sentBytes - controlBytes),
    savedPercent: Number(((1 - controlBytes / Math.max(1, sentBytes)) * 100).toFixed(1)) };

  console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, rounds: ROUNDS, environment: environment(), ...report }, null, 2));
} finally {
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
