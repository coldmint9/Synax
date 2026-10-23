/** Real Rust storage benchmark: 10x sealed history, fixed live tail, one full
 * fork. No network provider; semantic quality is covered by separate tests. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { RustRuntimeSupervisor } from "../services/local-node/infrastructure/runtime/rust-sidecar.js";
import { RuntimeSidecarClient } from "../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js";

const root = await mkdtemp(path.join(tmpdir(), "synax-checkpoint-benchmark-"));
const supervisor = new RustRuntimeSupervisor({ dataRoot: root });
let client: RuntimeSidecarClient;
let sequence = 0;
let requests = 0;
let responseBytes = 0;
async function command(sessionId: string, operation: string, payload: unknown): Promise<any> {
  requests++;
  const raw = await client.historyCommandGlobal({ sessionId, operation, requestId: `bench-${++sequence}`, payload });
  responseBytes += raw.byteLength;
  return JSON.parse(Buffer.from(raw).toString());
}
function sampleRust() {
  const pid = process.env.SYNAX_RUNTIME_SIDECAR_PID;
  const output = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const [rss, time] = output.split(/\s+/);
  const fields = time.split(":").map(Number);
  return { rssKiB: Number(rss), cpuMs: fields.reduce((total, n) => total * 60 + n, 0) * 1000 };
}
const summary = { goal: ["Continue"], constraints: [], decisions: [], completedWork: [], evidence: [], failures: [], openQuestions: [], nextActions: [] };
const rows: Array<Record<string, number>> = [];
const repeated: Array<Record<string, number>> = [];
try {
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  for (const count of [200, 2000]) {
    const sessionId = `bench-${String(count).padStart(4, "0")}`;
    const content = "Historical evidence. ".repeat(50);
    for (let offset = 0; offset < count; offset += 100) await command(sessionId, "append_entities", { objects:
      Array.from({ length: Math.min(100, count - offset) }, (_, n) => ({ kind: "runtime.message", value: {
        id: `old-${offset + n}`, sessionId, sequence: offset + n + 1, role: "assistant", content,
      } })) });
    await command(sessionId, "append_entities", { objects: [{ kind: "runtime.step", value: {
      id: "last-step", sessionId, runId: "old-run", index: 1, status: "completed",
    } }] });
    const head = await command(sessionId, "context_current", {});
    const active = await command(sessionId, "context_begin", { runId: "compact", stepId: "compact-step", throughStepId: "last-step", expectedRevision: head.revision });
    const checkpoint = { version: 1, id: "cmp_bench", sessionId, compactionRunId: "compact", throughRevision: active.throughRevision,
      throughStepId: "last-step", summary, sourceRefs: [], sourceFingerprint: active.sourceFingerprint, createdAt: "2026-10-23T00:00:00Z" };
    await command(sessionId, "context_commit", { checkpoint });
    await command(sessionId, "append_entities", { objects: Array.from({ length: 20 }, (_, n) => ({ kind: "runtime.message", value: {
      id: `tail-${n}`, sessionId, sequence: count + n + 1, role: "assistant", content: "Fixed new evidence. ".repeat(20),
    } })) });
    const current = await command(sessionId, "context_current", {});
    const pages = async () => {
      let cursor: unknown = null;
      let records = 0;
      do {
        const page = await command(sessionId, "context_messages", { fromRevision: checkpoint.throughRevision,
          throughRevision: current.revision, generation: current.generation, cursor });
        records += page.items.length; cursor = page.cursor;
      } while (cursor);
      assert.equal(records, 20);
    };
    await pages(); // Warm caches independently of the measured sample.
    global.gc?.();
    const beforeRust = sampleRust();
    const beforeNode = process.cpuUsage();
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    const req = requests, bytes = responseBytes;
    for (let n = 0; n < 100; n++) await pages();
    const elapsed = performance.now() - start;
    const afterRust = sampleRust();
    const nodeCpu = process.cpuUsage(beforeNode);
    const tailRequests = requests - req, tailBytes = responseBytes - bytes;
    await command(sessionId, "checkpoint", { objectId: (await command(sessionId, "head_read", {})).objectId,
      pinId: "fork-entry", metadata: { messageId: "tail-0", kind: "reply" } });
    const forkStart = performance.now(), forkRust = sampleRust();
    const fork = await command(`copy-${count}`, "fork_copy", { sourceSessionId: sessionId, checkpointId: "fork-entry", allowSourceChanges: true });
    const forkEndRust = sampleRust();
    rows.push({ oldMessages: count, newMessages: 20, checkpointBytes: Buffer.byteLength(JSON.stringify(checkpoint)),
      queryRequests: tailRequests, queryResponseBytes: tailBytes, queryWallMs: elapsed,
      queryNodeCpuMs: (nodeCpu.user + nodeCpu.system) / 1000, queryRustCpuMs: afterRust.cpuMs - beforeRust.cpuMs,
      nodeHeapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore), rustRssBeforeKiB: beforeRust.rssKiB,
      rustRssAfterKiB: afterRust.rssKiB, forkWallMs: performance.now() - forkStart,
      forkRustCpuMs: forkEndRust.cpuMs - forkRust.cpuMs, forkSampleRssKiB: forkEndRust.rssKiB,
      forkCopiedBytes: fork.copiedBytes, forkCopiedRecords: fork.copiedRecords,
    });
  }
  assert.equal(rows[0].queryRequests, rows[1].queryRequests);
  assert(rows[1].queryResponseBytes <= rows[0].queryResponseBytes * 1.05);
  assert(Math.abs(rows[1].checkpointBytes - rows[0].checkpointBytes) < 20);
  assert(rows[1].forkCopiedBytes < rows[0].forkCopiedBytes * 12);
  for (const count of [20, 200]) {
    const sessionId = `cycles-${count}`;
    let previous = 0, checkpointBytes = 0, pages = 0;
    const start = performance.now(), cpu = sampleRust();
    for (let cycle = 0; cycle < count; cycle++) {
      const stepId = `step-${cycle}`;
      await command(sessionId, "append_entities", { objects: [
        { kind: "runtime.message", value: { id: `m-${cycle}`, sessionId, sequence: cycle + 1, role: "assistant", content: "New evidence. ".repeat(50) } },
        { kind: "runtime.step", value: { id: stepId, sessionId, status: "completed", index: cycle } },
      ] });
      const head = await command(sessionId, "context_current", {});
      const page = await command(sessionId, "context_messages", { fromRevision: previous, throughRevision: head.throughRevision, generation: head.generation });
      assert.equal(page.items.length, 1); assert(!page.cursor); pages++;
      const active = await command(sessionId, "context_begin", { runId: `run-${cycle}`, stepId: `cmp-step-${cycle}`, throughStepId: stepId, expectedRevision: head.revision });
      const checkpoint = { version: 1, id: `cmp_${cycle}`, sessionId, compactionRunId: `run-${cycle}`,
        throughRevision: active.throughRevision, throughStepId: stepId, summary, sourceRefs: [],
        sourceFingerprint: active.sourceFingerprint, createdAt: "2026-10-23T00:00:00Z" };
      await command(sessionId, "context_commit", { checkpoint });
      previous = active.throughRevision; checkpointBytes = Math.max(checkpointBytes, Buffer.byteLength(JSON.stringify(checkpoint)));
    }
    const measured = sampleRust();
    await command(sessionId, "append_entities", { objects: [{ kind: "runtime.message", value: { id: "new", sessionId, role: "user", content: "Continue", sequence: count + 1 } }] });
    const head = await command(sessionId, "head_read", {});
    await command(sessionId, "checkpoint", { objectId: head.objectId, pinId: "entry", metadata: { messageId: "new", kind: "reply" } });
    const fork = await command(`copy-cycles-${count}`, "fork_copy", { sourceSessionId: sessionId, checkpointId: "entry", allowSourceChanges: true });
    repeated.push({ checkpoints: count, maxCheckpointBytes: checkpointBytes, deltaReadPages: pages,
      wallMs: performance.now() - start, rustCpuMs: measured.cpuMs - cpu.cpuMs,
      retainedLogBytes: fork.copiedBytes, retainedLogRecords: fork.copiedRecords });
  }
  assert(repeated[1].retainedLogBytes < repeated[0].retainedLogBytes * 12);
  assert(repeated[1].retainedLogRecords < repeated[0].retainedLogRecords * 12);
  assert(repeated[1].maxCheckpointBytes < repeated[0].maxCheckpointBytes + 32);
  const report = { platform: `${process.platform}-${process.arch}`, rows, repeated,
    notes: "RSS is sampled, not an allocation peak. Rust CPU is process time reported by ps (coarse precision). Query assertions verify fixed delta reads; fork assertions verify linear bytes/records. Timing is reported, not used as a flaky correctness gate." };
  await mkdir(".tmp/checkpoint-performance", { recursive: true });
  await writeFile(".tmp/checkpoint-performance/report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  client?.close();
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
