/** Local fixture → real provider/loop HTTP → production Node consumer → hot/history IPC.
 * No credentials, remote APIs or user sessions. Outputs JSON + process samples.
 * SYNAX_STRESS_CASES selects comma-separated cases; settings are recorded in results.json.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RustRuntimeSupervisor } from "../services/local-node/infrastructure/runtime/rust-sidecar.js";
import { RuntimeSidecarClient } from "../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js";
import { streamRustAgentLoop, sendRustAgentToolResult } from "../services/local-node/modules/agent-runtime/rust-agent-loop-client.js";
import { RuntimeStreamWriter } from "../services/local-node/modules/agent-runtime/runtime-stream-writer.js";
import { runtimeFacade } from "../services/local-node/modules/agent-runtime/sidecar/runtime-facade.js";

const output = path.resolve(process.env.SYNAX_STRESS_OUTPUT ?? ".tmp/runtime-concurrency-2026-10-21");
const settings = {
  sessions: Number(process.env.SYNAX_STRESS_SESSIONS ?? 10),
  rounds: Number(process.env.SYNAX_STRESS_ROUNDS ?? 24),
  deltas: Number(process.env.SYNAX_STRESS_DELTAS ?? 24),
  intervalMs: Number(process.env.SYNAX_STRESS_INTERVAL_MS ?? 15),
  toolBytes: Number(process.env.SYNAX_STRESS_TOOL_BYTES ?? 32768),
  promptBytes: Number(process.env.SYNAX_STRESS_PROMPT_BYTES ?? 65536),
  idleMs: Number(process.env.SYNAX_STRESS_IDLE_MS ?? 5000),
};
assert.equal(process.platform, "darwin", "This sampler measures macOS physical footprint.");
assert(Object.values(settings).every(value => Number.isSafeInteger(value) && value > 0));
await mkdir(output, { recursive: true });
const samplerBinary = path.join(output, "process-sampler");
execFileSync("clang", ["-O2", "scripts/runtime-process-sampler.c", "-o", samplerBinary]);
const binary = path.join(output, "synax-runtime-sidecar");
await copyFile(path.resolve(process.env.SYNAX_RUNTIME_SIDECAR_BIN ?? "runtime-sidecar/target/release/synax-runtime-sidecar"), binary);
const binaryHash = createHash("sha256").update(await readFile(binary)).digest("hex");
const sourceHash = createHash("sha256").update(await readFile("services/local-node/modules/agent-runtime/rust-agent-loop-client.ts")).digest("hex");
const originalFetch = globalThis.fetch;
type Sample = { at: number; pid: number; footprint: number; resident: number; peakFootprint: number; cpuNs: number; readBytes: number; writeBytes: number; pageins: number; threads: number; phase: string };
type Case = { name: string; persist: boolean; ack: boolean; providerLimit: number; waves: number; slow?: boolean; reconnect?: boolean; batch?: boolean; writer?: boolean; header?: boolean };
const cases: Case[] = [
  { name: "loop-10-ack", persist: false, ack: true, providerLimit: 10, waves: 1 },
  { name: "loop-10-noack-control", persist: false, ack: false, providerLimit: 10, waves: 1 },
  { name: "persist-10-ack", persist: true, ack: true, providerLimit: 10, waves: 1 },
  { name: "persist-10-slow-reconnect", persist: true, ack: true, providerLimit: 10, waves: 1, slow: true, reconnect: true },
  { name: "persist-10-default8", persist: true, ack: true, providerLimit: 8, waves: 1 },
  { name: "persist-10-repeat3", persist: true, ack: true, providerLimit: 10, waves: 3 },
  { name: "persist-10-batch8", persist: true, ack: true, providerLimit: 10, waves: 1, batch: true },
  { name: "persist-10-production-writer", persist: true, ack: true, providerLimit: 10, waves: 1, writer: true },
  { name: "persist-10-production-writer-repeat3", persist: true, ack: true, providerLimit: 10, waves: 3, writer: true },
  { name: "persist-10-large-header-batch8", persist: true, ack: true, providerLimit: 10, waves: 1, batch: true, header: true },
];
const selected = process.env.SYNAX_STRESS_CASES?.split(",");
const distributions = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (v: number) => Number((sorted[Math.max(0, Math.ceil(sorted.length * v) - 1)] ?? 0).toFixed(3));
  return { count: values.length, p50: p(.5), p95: p(.95), p99: p(.99), max: p(1) };
};
const mib = (bytes: number) => Number((bytes / 1048576).toFixed(3));
const deltaText = (model: string, round: number, delta: number) =>
  `${model}|round=${round}|delta=${delta}| Stream 流式输出 😀. function check(value) { return value + 1; }\n`;
const toolResult = (model: string, round: number) => ({ matches: Array.from({ length: Math.ceil(settings.toolBytes / 256) }, (_, index) => ({
  path: `src/feature-${index}/module-${round}.ts`, line: index * 11 + 1,
  text: `${model}/${round}/${index}: export function readContext() { return state.current; } `.padEnd(190, " code"),
})) });
async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(target) : (await stat(target)).size;
  }
  return bytes;
}

const report: Record<string, unknown> = {
  createdAt: new Date().toISOString(), platform: `${os.platform()}-${os.arch()}`, release: os.release(),
  cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, systemMemoryMiB: mib(os.totalmem()),
  workspaceVersion: (await readFile(".env.version", "utf8")).trim(), binaryHash, consumerSourceHash: sourceHash,
  gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scriptHash: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex"),
  workingDiffHash: createHash("sha256").update(execFileSync("git", ["diff", "--", "runtime-sidecar", "services/local-node/modules/agent-runtime/rust-agent-loop-client.ts"])).digest("hex"),
  exampleToolResultBytes: Buffer.byteLength(JSON.stringify(toolResult("session-0-wave-0", 1))), settings,
  scope: "Real Rust provider/loop, production Node event consumer and optional hot/history IPC; simulated tool results. Excludes Electron rendering and real tools/network. Provider concurrency explicitly verified. Context compaction omitted to expose retained working-set growth.",
  results: [] as unknown[],
};
await writeFile(path.join(output, "manifest.json"), JSON.stringify(report, null, 2));

for (const scenario of cases.filter(item => !selected || selected.includes(item.name))) {
  const root = await mkdtemp(path.join(os.tmpdir(), "synax-stress-"));
  const supervisor = new RustRuntimeSupervisor({ dataRoot: root, binaryPath: binary,
    env: { SYNAX_RESOURCE_PROVIDER_LIMIT: String(scenario.providerLimit), RUST_LOG: "off", SYNAX_RUNTIME_LOG_DIR: path.join(root, "logs") } });
  let client: RuntimeSidecarClient | undefined;
  let sampler: ReturnType<typeof spawn> | undefined;
  let phase = "startup";
  let providerActive = 0, providerPeak = 0, providerCalls = 0;
  let acknowledgements = 0, observedBytes = 0, highestOutstanding = 0, disconnected = 0, historyQueries = 0;
  const emittedAt = new Map<string, number>();
  const receivedByLoop = new Map<string, { total: number; acked: number; sequences: Map<number, number> }>();
  const endedLoops: Array<{ id: string; sequence: number }> = [];
  const cutLoops = new Set<string>();
  const cuts = new Set<string>();
  const samples: Sample[] = [], eventDelays: number[] = [], committedDelays: number[] = [], appendMs: number[] = [], historyMs: number[] = [], healthMs: number[] = [], firstTokenMs: number[] = [];
  const peakByWave: number[] = [];
  let error: string | undefined;
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let healthFailure: string | undefined;
  let productionAppendCalls = 0;
  const productionBatchSizes: number[] = [];
  let previousSocket: string | undefined;
  let previousToken: string | undefined;
  let originalWriterAppend: typeof runtimeFacade.appendStreamAuthoritative | undefined;
  const abort = new AbortController();
  const completed: Array<Record<string, unknown>> = [];
  const rounds = new Map<string, number>();
  const fixture = http.createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const wire = JSON.parse(body);
      const model = String(wire.model);
      const warmup = model === "warmup";
      const round = (rounds.get(model) ?? 0) + 1;
      rounds.set(model, round);
      if (!warmup) { providerCalls++; providerPeak = Math.max(providerPeak, ++providerActive); }
      response.once("close", () => { if (!warmup) providerActive--; });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish: string | null = null) => response.write(`data: ${JSON.stringify({
        id: `fixture-${model}-${round}`, object: "chat.completion.chunk", model, created: 0,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      for (let index = 0; index < (warmup ? 1 : settings.deltas); index++) {
        if (response.destroyed) return;
        const text = deltaText(model, round, index);
        emittedAt.set(text, performance.now());
        send(index % 4 === 0 ? { reasoning_content: text } : { content: text });
        if (!warmup) await sleep(settings.intervalMs);
      }
      if (!warmup && round < settings.rounds) send({ tool_calls: [{ index: 0, id: `call-${model}-${round}`, type: "function",
        function: { name: "fixture_search", arguments: JSON.stringify({ round }) } }] }, "tool_calls");
      else send({}, "stop");
      response.end("data: [DONE]\n\n");
    } catch (cause) { response.destroy(cause as Error); }
  });
  const post = async (route: string, payload: unknown) => {
    const response = await originalFetch(`http://127.0.0.1:${supervisor.providerPort}${route}`, { method: "POST",
      headers: { authorization: `Bearer ${supervisor.token}`, "content-type": "application/json" }, body: JSON.stringify(payload), signal: abort.signal });
    if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
    return response;
  };
  try {
    await supervisor.start();
    previousSocket = process.env.SYNAX_RUNTIME_SIDECAR_SOCKET;
    previousToken = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
    process.env.SYNAX_RUNTIME_SIDECAR_SOCKET = supervisor.socketPath;
    process.env.SYNAX_RUNTIME_SIDECAR_TOKEN = supervisor.token;
    originalWriterAppend = runtimeFacade.appendStreamAuthoritative;
    if (scenario.writer) {
      runtimeFacade.appendStreamAuthoritative = async function (input: Parameters<typeof runtimeFacade.appendStreamAuthoritative>[0]) {
        productionAppendCalls++;
        productionBatchSizes.push(input.chunks.length);
        const at = performance.now();
        try { return await originalWriterAppend!.call(runtimeFacade, input); }
        finally { appendMs.push(performance.now() - at); }
      };
    }
    client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token, requestTimeoutMs: 30000 });
    const pid = supervisor.process!.pid!;
    sampler = spawn(samplerBinary, [String(pid), String(process.pid)], { stdio: ["ignore", "pipe", "inherit"] });
    createInterface({ input: sampler.stdout! }).on("line", line => {
      const sample = { ...JSON.parse(line), phase } as Sample;
      samples.push(sample);
      if (sample.pid === pid && sample.footprint > 3 * 1024 ** 3) abort.abort(new Error("Benchmark exceeded 3 GiB footprint."));
    });
    await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`;
    // Wrap only the local bridge: ACK suppression is a paired retention control,
    // and socket cuts leave the real Rust queue responsible for gap recovery.
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (address.endsWith("/agent-loop/ack")) {
        const { loopId, through } = JSON.parse(String(init?.body));
        const counters = receivedByLoop.get(loopId);
        acknowledgements++;
        if (scenario.ack && counters) counters.acked = counters.sequences.get(through) ?? counters.acked;
        if (!scenario.ack) return Response.json({ ok: true });
      }
      const response = await originalFetch(url, init);
      if (!address.includes("/agent-loop/events?") || !response.body || !scenario.reconnect) return response;
      const id = new URL(address).searchParams.get("loopId")!;
      if (!cutLoops.has(id) || cuts.has(id)) return response;
      const reader = response.body.getReader();
      let pending = Buffer.alloc(0), cut = false, count = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          if (cut) { controller.error(new TypeError("benchmark disconnected observation socket")); return; }
          const next = await reader.read();
          if (next.done) { controller.close(); return; }
          pending = Buffer.concat([pending, next.value]);
          let offset = 0, newline: number;
          while ((newline = pending.indexOf(10, offset)) !== -1) {
            const event = JSON.parse(pending.subarray(offset, newline).toString());
            offset = newline + 1;
            if (event.type === "text-delta" && ++count === 12) {
              cut = true; cuts.add(id); disconnected++;
              controller.enqueue(pending.subarray(0, offset)); await reader.cancel(); return;
            }
          }
          if (offset) { controller.enqueue(pending.subarray(0, offset)); pending = pending.subarray(offset); }
        }, cancel() { return reader.cancel(); },
      }));
    };
    let warmed = false;
    for await (const event of streamRustAgentLoop({ apiFormat: "openai", model: "warmup", baseUrl,
      prompt: [{ role: "user", content: "Warm up the local fixture." }], maxRetries: 0 }, abort.signal)) {
      assert.notEqual(event.type, "error", event.error);
      if (event.type === "done") warmed = true;
    }
    assert(warmed, "Warmup must finish before collecting the baseline.");
    phase = "baseline";
    await sleep(1000);
    const baseline = samples.filter(row => row.pid === pid).at(-1)!;
    const healthPoll = async () => {
      if (stopped) return;
      const at = performance.now();
      try { assert.equal((await client!.health()).ok, true); healthMs.push(performance.now() - at); }
      catch (cause) { healthFailure = String(cause); }
      if (!stopped) healthTimer = setTimeout(healthPoll, 1000);
    };
    void healthPoll();
    const started = performance.now();
    const prompt = "Relevant source and prior tool evidence. ".repeat(Math.ceil(settings.promptBytes / 40)).slice(0, settings.promptBytes);
    const tools = Array.from({ length: 16 }, (_, index) => ({ name: index ? `fixture_unused_${index}` : "fixture_search", description: "Find relevant code and return the matching lines.",
      inputSchema: { type: "object", properties: { round: { type: "number" }, path: { type: "string" }, query: { type: "string" } } } }));
    let commands = 0;
    const persist = async (sessionId: string, objects: unknown[]) => {
      const at = performance.now();
      await client!.historyCommand({ sessionId, requestId: `stress:${++commands}`, operation: "append_entities", payload: { objects } });
      historyMs.push(performance.now() - at);
    };
    for (let wave = 0; wave < scenario.waves; wave++) {
      phase = `wave-${wave + 1}`;
      const waveAt = Date.now();
      const jobs = Array.from({ length: settings.sessions }, async (_, index) => {
        const model = `session-${index}-wave-${wave}`, sessionId = `stress-session-${index}`, runId = `stress-run-${index}-${wave}`;
        let producerSequence = 0, stepId = "", step: Record<string, unknown> = {}, text = "", thought = "", toolCount = 0, deltas = 0, events = 0, prior = 0;
        let loopId = "", first = true;
        const writer = scenario.writer ? new RuntimeStreamWriter(sessionId, runId) : undefined;
        const seenTools = new Set<string>();
        const sentAt = new Map<string, number>();
        let epoch = 0, revision = 0;
        const run = { id: runId, sessionId, status: "queued", startedAt: new Date().toISOString(), completedAt: null, metadata: {} };
        const state = { status: "running", activeRunId: runId, pendingResumeToken: null, blockedReason: null, updatedAt: run.startedAt };
        if (scenario.persist) {
          if (wave === 0) await client!.seedUi(sessionId, Buffer.from(JSON.stringify({ id: sessionId, projectId: "stress", status: "queued", updatedAt: run.startedAt,
            ...(scenario.header ? { sessionMetadata: { latestSystemPrompt: prompt } } : {}) })));
          const before = await client!.snapshot(sessionId);
          await client!.admitRun({ sessionId, requestId: `admit:${runId}`, bodyHash: runId, runId, run, epoch: before.epoch, revision: before.revision });
          const fence = await client!.snapshot(sessionId);
          await client!.activateRun({ sessionId, requestId: `activate:${runId}`, epoch: fence.epoch, revision: fence.revision, run });
          epoch = fence.epoch; revision = fence.revision;
          await persist(sessionId, [{ kind: "runtime.run", value: { ...run, status: "running" } }]);
        }
        const append = async (chunks: Record<string, unknown>[]) => {
          if (!scenario.persist) return;
          if (writer) {
            for (const chunk of chunks) writer.write(chunk as never);
            return;
          }
          const at = performance.now();
          await client!.appendStream({ sessionId, runId, producerId: runId, producerSequence: ++producerSequence, epoch, revision,
            durability: "group_commit", events: chunks.map(chunk => ({ kind: String(chunk.type), payload: Buffer.from(JSON.stringify({ schema: 1, chunk, state })) })) });
          appendMs.push(performance.now() - at);
          for (const chunk of chunks) {
            if (typeof chunk.delta !== "string") continue;
            committedDelays.push(performance.now() - sentAt.get(chunk.delta)!);
            sentAt.delete(chunk.delta);
          }
        };
        let pendingDeltas: Record<string, unknown>[] = [], bufferedAt = 0;
        const flush = async () => {
          if (!pendingDeltas.length) return;
          const batch = pendingDeltas; pendingDeltas = [];
          await append(batch);
        };
        const launchAt = performance.now();
        for await (const event of streamRustAgentLoop({ apiFormat: "openai", model, baseUrl, prompt: [{ role: "user", content: prompt }], tools,
          maxRetries: 0, cachePolicy: { sessionId, rootSessionId: sessionId } }, abort.signal, id => {
            loopId = id; receivedByLoop.set(id, { total: 0, acked: 0, sequences: new Map() });
            if (scenario.reconnect && index < 5) cutLoops.add(id);
          })) {
          assert.equal(event.sequence, prior + 1, "event gap or duplicate"); prior = event.sequence!; events++;
          const counter = receivedByLoop.get(loopId)!;
          const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
          counter.total += bytes; observedBytes += bytes; counter.sequences.set(prior, counter.total);
          highestOutstanding = Math.max(highestOutstanding, [...receivedByLoop.values()].reduce((sum, value) => sum + value.total - value.acked, 0));
          if (event.type !== "text-delta" && event.type !== "reasoning-delta") await flush();
          if (event.type === "step-started") {
            text = ""; thought = ""; stepId = `${runId}-step-${event.step}`;
            step = { id: stepId, sessionId, runId, index: event.step, status: "running", startedAt: new Date().toISOString(), completedAt: null, metadata: {} };
            await append([{ type: "step_started", step }]);
          } else if (event.type === "text-delta" || event.type === "reasoning-delta") {
            const emitted = emittedAt.get(event.delta!);
            assert.notEqual(emitted, undefined, "unexpected/cross-session delta");
            eventDelays.push(performance.now() - emitted!); emittedAt.delete(event.delta!);
            sentAt.set(event.delta!, emitted!);
            if (first) { firstTokenMs.push(performance.now() - launchAt); first = false; }
            deltas++;
            if (event.type === "text-delta") text += event.delta; else thought += event.delta;
            const chunk = { type: event.type === "text-delta" ? "message_delta" : "thought_delta", runId, stepId, delta: event.delta,
              ...(event.type === "text-delta" ? { outputTokens: event.outputTokens } : { thinkingTokens: event.thinkingTokens }) };
            if (scenario.batch) {
              if (!pendingDeltas.length) bufferedAt = performance.now();
              pendingDeltas.push(chunk);
              if (pendingDeltas.length >= 8 || performance.now() - bufferedAt >= 40) await flush();
            } else await append([chunk]);
            if (scenario.slow && index < 3) await sleep(30);
          } else if (event.type === "assistant-message") {
            const parts = event.message!.content as Array<{ type: string; text?: string }>;
            assert.equal(parts.filter(part => part.type === "text").map(part => part.text).join(""), text);
            const message = { id: `${stepId}-message`, sessionId, runId, stepId, role: "assistant", content: text, metadata: { thought, rustMessage: event.message }, createdAt: new Date().toISOString() };
            if (scenario.persist) await persist(sessionId, [{ kind: "runtime.message", value: message }, { kind: "runtime.step", value: { ...step, status: "completed" } }]);
            await append([{ type: "message", message }]);
          } else if (event.type === "tool-call") {
            assert(!seenTools.has(event.toolCallId!), "tool executed twice"); seenTools.add(event.toolCallId!); toolCount++;
            const round = Number((event.input as { round: number }).round);
            const result = toolResult(model, round);
            if (scenario.persist) {
              const tool = { id: event.toolCallId, sessionId, runId, stepId, toolId: "fixture_search", status: "completed", inputRef: event.input, outputRef: result,
                inputSummary: "search fixture", outputSummary: `Found ${result.matches.length} matches`, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
              await persist(sessionId, [{ kind: "runtime.tool_call", value: tool }]);
              await append([{ type: "tool_result", runId, stepId, toolCall: tool }]);
            }
            await sendRustAgentToolResult({ loopId, toolCallId: event.toolCallId!, result, signal: abort.signal });
          } else if (event.type === "tool-result" && scenario.persist) {
            await persist(sessionId, [{ kind: "runtime.message", value: { id: `${event.toolCallId}-result`, sessionId, runId, stepId, role: "tool",
              content: JSON.stringify(event.result), metadata: { rustMessage: { role: "tool", content: [{ type: "tool-result", toolCallId: event.toolCallId, output: event.result }] } }, createdAt: new Date().toISOString() } }]);
          } else if (event.type === "error" || event.type === "cancelled") throw new Error(event.error ?? event.type);
        }
        await flush();
        if (writer) {
          writer.flush();
          await writer.settled();
        }
        assert.equal(toolCount, settings.rounds - 1);
        assert.equal(deltas, settings.rounds * settings.deltas);
        endedLoops.push({ id: loopId, sequence: prior });
        if (scenario.persist) {
          const fence = await client!.snapshot(sessionId);
          const finished = { ...run, status: "completed", completedAt: new Date().toISOString() };
          await client!.finishRun({ sessionId, requestId: `finish:${runId}`, runId, status: "completed", epoch: fence.epoch, revision: fence.revision, run: finished });
          await persist(sessionId, [{ kind: "runtime.run", value: finished }]);
          let cursor: unknown, messages = 0;
          do {
            historyQueries++;
            const page = JSON.parse(Buffer.from(await client!.historyCommand({ sessionId, requestId: `verify:${runId}:${historyQueries}`, operation: "list_messages", payload: { limit: 256, cursor } })).toString());
            messages += page.items.length; cursor = page.cursor;
          } while (cursor);
          assert.equal(messages, (wave + 1) * (settings.rounds * 2 - 1));
          const snap = JSON.parse(Buffer.from(await client!.uiSnapshot(sessionId)).toString());
          assert.equal(snap.session.status, "completed");
        }
        completed.push({ wave: wave + 1, sessionId, loopId, events, deltas, toolCount, durationMs: performance.now() - launchAt });
      });
      await Promise.all(jobs);
      phase = `idle-${wave + 1}`;
      await sleep(settings.idleMs);
      peakByWave.push(Math.max(...samples.filter(row => row.pid === pid && row.at >= waveAt).map(row => row.footprint)));
      console.log(`${scenario.name}: wave ${wave + 1}/${scenario.waves} done, footprint=${mib(samples.filter(row => row.pid === pid).at(-1)!.footprint)}MiB`);
    }
    const elapsedMs = performance.now() - started;
    // Verify confirmed data really cannot be replayed; no-ACK control must retain it.
    for (const loop of endedLoops) {
      const response = await originalFetch(`http://127.0.0.1:${supervisor.providerPort}/agent-loop/events?loopId=${loop.id}&after=0`, { headers: { authorization: `Bearer ${supervisor.token}` }, signal: abort.signal });
      assert.equal(response.status, scenario.ack ? 409 : 200); await response.body?.cancel();
    }
    const native = samples.filter(row => row.pid === pid);
    const after = native.at(-1)!;
    const active = native.filter(row => row.phase.startsWith("wave-"));
    const cpu = active.slice(1).map((row, i) => (row.cpuNs - active[i].cpuNs) / ((row.at - active[i].at) * 1e6) * 100);
    assert.equal(supervisor.generation, 1, "sidecar restarted under load");
    assert.equal(completed.length, settings.sessions * scenario.waves);
    assert.equal(providerCalls, settings.sessions * scenario.waves * settings.rounds);
    assert.equal(healthFailure, undefined);
    (report.results as unknown[]).push({ ...scenario, ok: true, sidecarPid: pid, elapsedMs,
      providerPeak, providerCalls, completed: completed.length, acknowledgements, disconnected, historyQueries,
      observedEventMiB: mib(observedBytes), clientOutstandingMiB: mib(highestOutstanding),
      baselineMiB: mib(baseline.footprint), peakMiB: mib(Math.max(...native.map(row => row.peakFootprint))), idleMiB: mib(after.footprint),
      peakResidentMiB: mib(Math.max(...native.map(row => row.resident))), driverPeakMiB: mib(Math.max(...samples.filter(row => row.pid !== pid).map(row => row.footprint))),
      wavePeakMiB: peakByWave.map(mib), waveIdleMiB: Array.from({ length: scenario.waves }, (_, i) => mib(native.filter(row => row.phase === `idle-${i + 1}`).at(-1)?.footprint ?? 0)),
      cpuPercent: distributions(cpu), cpuSeconds: (after.cpuNs - baseline.cpuNs) / 1e9,
      diskReadMiB: mib(after.readBytes - baseline.readBytes), diskWriteMiB: mib(after.writeBytes - baseline.writeBytes), storeMiB: mib(await directoryBytes(root)),
      pageins: after.pageins - baseline.pageins, eventDelayMs: distributions(eventDelays), committedDeltaMs: distributions(committedDelays), firstTokenMs: distributions(firstTokenMs),
      hotAppendMs: distributions(appendMs), productionAppendCalls, productionBatchSizes: distributions(productionBatchSizes), historyAppendMs: distributions(historyMs), healthMs: distributions(healthMs),
    });
  } catch (cause) {
    error = String(cause); abort.abort(cause);
    (report.results as unknown[]).push({ ...scenario, ok: false, error, completed: completed.length, providerPeak, providerCalls });
    console.error(`${scenario.name}: ${error}`);
  } finally {
    if (originalWriterAppend) runtimeFacade.appendStreamAuthoritative = originalWriterAppend;
    if (previousSocket === undefined) delete process.env.SYNAX_RUNTIME_SIDECAR_SOCKET;
    else process.env.SYNAX_RUNTIME_SIDECAR_SOCKET = previousSocket;
    if (previousToken === undefined) delete process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
    else process.env.SYNAX_RUNTIME_SIDECAR_TOKEN = previousToken;
    stopped = true; clearTimeout(healthTimer); globalThis.fetch = originalFetch;
    sampler?.kill(); client?.close(); fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await supervisor.stop();
    await writeFile(path.join(output, `${scenario.name}-samples.jsonl`), samples.map(row => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(path.join(output, `${scenario.name}-sessions.json`), JSON.stringify(completed, null, 2));
    await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2));
    await rm(root, { recursive: true, force: true });
  }
  if (error) process.exitCode = 1;
}
console.log(JSON.stringify(report, null, 2));
