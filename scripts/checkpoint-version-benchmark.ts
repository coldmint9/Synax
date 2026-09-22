/** Disk-backed core probe only. Never opens DATA_ROOT or an existing database. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "libsql";
import { VersionObjects } from "../api/services/agent-runtime/checkpoints/version-store/objects.js";
import { VersionTree } from "../api/services/agent-runtime/checkpoints/version-store/tree.js";
import { VersionHeads } from "../api/services/agent-runtime/checkpoints/version-store/heads.js";
import { createVersion, readVersion } from "../api/services/agent-runtime/checkpoints/version-store/versions.js";
import { VersionCollector } from "../api/services/agent-runtime/checkpoints/version-store/gc.js";
import { VersionPins } from "../api/services/agent-runtime/checkpoints/version-store/pins.js";
import { VersionResources } from "../api/services/agent-runtime/checkpoints/version-store/resources.js";
import { atomicVersionWrite } from "../api/services/agent-runtime/checkpoints/version-store/transaction.js";

function integer(text: string | undefined, name: string, max: number): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}; expected 1..${max}.`);
  return value;
}
function parseOptions() {
  let entries = [10_000, 100_000, 1_000_000], switches = 1000, payloadBytes = 256, collect = false, checkpoints = 0, output: string | undefined;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${key}.`);
    if (key === "--entries") {
      const parts = value.split(",");
      if (!parts.length || parts.length > 8) throw new Error("Invalid --entries case count.");
      entries = parts.map(part => integer(part, "--entries", 1_000_000));
    } else if (key === "--switches") switches = integer(value, key, 10_000);
    else if (key === "--payload-bytes") payloadBytes = integer(value, key, 64 * 1024);
    else if (key === "--collect") {
      if (value !== "0" && value !== "1") throw new Error("Invalid --collect flag.");
      collect = value === "1";
    } else if (key === "--checkpoints") checkpoints = value === "0" ? 0 : integer(value, key, 1000);
    else if (key === "--output") output = value;
    else throw new Error(`Unknown option ${key}.`);
  }
  if (payloadBytes < 16) throw new Error("Payload must fit the unique 16-byte event identity.");
  return { entries, switches, payloadBytes, collect, checkpoints, output };
}
function timings(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { unit: "ms", p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], p99: sorted[Math.ceil(sorted.length * 0.99) - 1], max: sorted.at(-1), samples };
}
function fileSize(filename: string): number {
  try { return statSync(filename).size; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
function storageBreakdown(db: Database.Database) {
  // Diagnostics run only after timed operations; result cardinality is bounded by
  // object kinds / schema tables, not by the number of history rows.
  const objectsByKind = (db.prepare("SELECT kind,count(*) AS count,sum(length(payload)) AS payloadBytes,sum(logical_bytes) AS logicalBytes FROM conversation_v3_objects GROUP BY kind").all() as { kind: string; count: number; payloadBytes: number; logicalBytes: number }[])
    .map(row => ({ kind: row.kind, count: row.count, payloadBytes: row.payloadBytes, logicalBytes: row.logicalBytes }));
  try {
    const tables = (db.prepare("SELECT name,sum(pgsize) AS bytes,sum(payload) AS payloadBytes FROM dbstat GROUP BY name ORDER BY sum(pgsize) DESC").all() as { name: string; bytes: number; payloadBytes: number }[])
      .map(row => ({ name: row.name, bytes: row.bytes, payloadBytes: row.payloadBytes }));
    return { objectsByKind, tables };
  } catch (error) {
    return { objectsByKind, tables: null, unavailableReason: error instanceof Error ? error.message : String(error) };
  }
}
function runCase(entries: number, switches: number, payloadBytes: number, collect: boolean, checkpoints: number) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "synax-version-benchmark-"));
  const filename = path.join(directory, "benchmark.db");
  const db = new Database(filename);
  let peakRss = 0, peakHeap = 0, peakExternal = 0, peakArrayBuffers = 0;
  const sampleMemory = () => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed);
    peakExternal = Math.max(peakExternal, m.external); peakArrayBuffers = Math.max(peakArrayBuffers, m.arrayBuffers);
  };
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192; PRAGMA wal_autocheckpoint=1000;");
    for (const migration of ["0051_conversation_version_core.sql", "0052_conversation_version_heads.sql", "0053_conversation_compact_versions.sql"])
      db.exec(readFileSync(new URL(`../api/db/migrations/${migration}`, import.meta.url), "utf8"));
    const objects = new VersionObjects(db, { maxBytes: 1024 * 1024 * 1024, maxObjects: 2_000_000 });
    const tree = new VersionTree(objects), heads = new VersionHeads(db, objects);
    const pins = new VersionPins(db), collector = new VersionCollector(objects), resources = new VersionResources(db);
    const maintenance = { calls: 0, removed: 0, bytes: 0, edges: 0, ownershipRows: 0, maxCallMs: 0, remaining: false };
    const maintain = () => {
      const begin = performance.now(), result = collector.collect();
      maintenance.calls++; maintenance.removed += result.removed; maintenance.bytes += result.bytes;
      maintenance.edges += result.edges; maintenance.ownershipRows += result.ownershipRows;
      maintenance.remaining = result.remaining; maintenance.maxCallMs = Math.max(maintenance.maxCallMs, performance.now() - begin);
    };
    let checkpointPins = 0;
    let root: string | null = null;
    let head = heads.create("benchmark", createVersion(objects));
    let middleVersion = head.versionId, middleEntries = 0;
    const started = performance.now();
    sampleMemory();
    for (let base = 0; base < entries; base += 256) {
      atomicVersionWrite(db, () => {
        const changes = Array.from({ length: Math.min(256, entries - base) }, (_, offset) => {
          const key = String(base + offset).padStart(16, "0");
          const payload = Buffer.alloc(payloadBytes, 120);
          payload.write(key, 0, "ascii");
          return { key, value: objects.put("chunk", payload) };
        });
        root = tree.update(root, changes);
        const versionId = createVersion(objects, { transcriptRoot: root });
        head = heads.publish({ sessionId: "benchmark", versionId, expectedRevision: head.revision, expectedEpoch: head.epoch });
        if (!middleEntries && base + changes.length >= entries / 2) {
          middleVersion = versionId; middleEntries = base + changes.length;
          if (collect) pins.hold({ id: "benchmark-reader", objectId: versionId, kind: "reader", owner: "benchmark-reader-nonce" });
        }
        while (checkpointPins < checkpoints && base + changes.length >= Math.ceil((checkpointPins + 1) * entries / checkpoints)) {
          pins.hold({ id: `checkpoint-${checkpointPins++}`, objectId: versionId, kind: "checkpoint", owner: "benchmark-checkpoints" });
        }
      });
      if (collect) maintain();
      sampleMemory();
    }
    if (collect) {
      for (let batch = 0; maintenance.remaining && batch < 10000; batch++) { maintain(); sampleMemory(); }
      if (maintenance.remaining) throw new Error("Bounded benchmark maintenance did not finish within its call budget.");
    }
    const generationMs = performance.now() - started;
    const latestVersion = head.versionId;
    const before = objects.stats();
    const switchSamples: number[] = [], pageSamples: number[] = [], forkSamples: number[] = [];
    const requestHash = createHash("sha256").update("core-benchmark").digest("hex");
    for (let n = 0; n < switches; n++) {
      const targetVersionId = n % 2 ? latestVersion : middleVersion;
      let start = performance.now();
      head = heads.switch({ sessionId: "benchmark", targetVersionId, expectedRevision: head.revision, requestId: `switch-${n}`, requestHash });
      switchSamples.push(performance.now() - start);
      start = performance.now();
      const version = readVersion(objects, head.versionId);
      const page = tree.page(version.transcriptRoot, { limit: 64 });
      if (!page.entries.length) throw new Error("Unexpected empty benchmark index page.");
      pageSamples.push(performance.now() - start);
      start = performance.now();
      heads.fork({ sourceSessionId: "benchmark", targetSessionId: `fork-${n}`, versionId: targetVersionId, expectedRevision: head.revision, requestId: `fork-op-${n}`, requestHash });
      forkSamples.push(performance.now() - start);
      sampleMemory();
    }
    const after = objects.stats();
    if (after.bytes !== before.bytes || after.objects !== before.objects) throw new Error("Head operations copied immutable data.");
    return {
      entries, payloadBytes, middleEntries, generationMs, retainedCheckpointPins: checkpointPins, maintenance, metadata: resources.metadata(), disk: resources.disk(),
      switches: timings(switchSamples), firstIndexPages: timings(pageSamples), forks: timings(forkSamples),
      objectBytesBeforeSwitches: before.bytes, objectBytesAfterSwitches: after.bytes,
      objectCountBeforeSwitches: before.objects, objectCountAfterSwitches: after.objects,
      storage: storageBreakdown(db),
      files: { database: fileSize(filename), wal: fileSize(`${filename}-wal`), shm: fileSize(`${filename}-shm`) },
      memory: { peakRss, peakHeap, peakExternal, peakArrayBuffers, processMaxRssKiB: process.resourceUsage().maxRSS },
    };
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  const options = parseOptions();
  const report = {
    scope: "version-core-only", endToEndAccepted: false, timestamp: new Date().toISOString(),
    notes: ["Synthetic unique content; no runtime/UI/file restore or legacy migration exercised. GC is opt-in and bounded.", "First-index-page measures references, not full rendered message contents.", "RSS is sampled between bounded batches; processMaxRss includes earlier cases in this process.", "Physical disk reports DB/WAL/SHM before connection close; generation includes selected GC work, separate from head-operation timing.", "Warm in-process probe after generation, not a cold-start latency result."],
    environment: { node: process.version, platform: process.platform, architecture: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, totalMemory: os.totalmem(), execArgv: process.execArgv },
    sqlite: { journalMode: "WAL", synchronous: "FULL", cacheKiB: 8192, autoCheckpointPages: 1000 },
    cases: options.entries.map(entries => {
      console.error(`Core benchmark: ${entries} entries, ${options.switches} switches/forks, payload ${options.payloadBytes} bytes`);
      return runCase(entries, options.switches, options.payloadBytes, options.collect, options.checkpoints);
    }),
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (options.output) writeFileSync(options.output, json, { flag: "wx" });
  else process.stdout.write(json);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
