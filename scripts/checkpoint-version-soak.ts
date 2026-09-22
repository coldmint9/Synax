import { VERSION_SCHEMA_MIGRATIONS } from "../api/services/agent-runtime/checkpoints/version-store/schema.js";
/** Isolated bounded-resource soak. Does not load application DATA_ROOT. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "libsql";
import { VersionObjects } from "../api/services/agent-runtime/checkpoints/version-store/objects.js";
import { VersionHeads, type HeadState } from "../api/services/agent-runtime/checkpoints/version-store/heads.js";
import { VersionTree } from "../api/services/agent-runtime/checkpoints/version-store/tree.js";
import { VersionPins } from "../api/services/agent-runtime/checkpoints/version-store/pins.js";
import { VersionCollector } from "../api/services/agent-runtime/checkpoints/version-store/gc.js";
import { VersionResources } from "../api/services/agent-runtime/checkpoints/version-store/resources.js";
import { createVersion, readVersion } from "../api/services/agent-runtime/checkpoints/version-store/versions.js";
import { atomicVersionWrite } from "../api/services/agent-runtime/checkpoints/version-store/transaction.js";

function options() {
  let operations = 10000, output: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (value === undefined) throw new Error(`Missing ${key} value.`);
    if (key === "--operations") operations = Number(value);
    else if (key === "--output") output = value;
    else throw new Error(`Unknown option ${key}.`);
  }
  if (!Number.isSafeInteger(operations) || operations < 1 || operations > 100000) throw new Error("Operations must be 1..100000.");
  return { operations, output };
}
function run(operations: number) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "synax-version-soak-"));
  const db = new Database(path.join(directory, "soak.db"));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192; PRAGMA wal_autocheckpoint=1000;");
    for (const file of VERSION_SCHEMA_MIGRATIONS)
      db.exec(readFileSync(new URL(`../api/db/migrations/${file}`, import.meta.url), "utf8"));
    const objects = new VersionObjects(db, { maxBytes: 64 * 1024 * 1024, maxObjects: 100000 });
    const tree = new VersionTree(objects), heads = new VersionHeads(db, objects), pins = new VersionPins(db);
    const collector = new VersionCollector(objects), resources = new VersionResources(db);
    const base = createVersion(objects);
    let head = heads.create("soak", base), root: string | null = null, fork: HeadState | undefined;
    pins.hold({ id: "base", objectId: base, kind: "checkpoint", owner: "soak-base" });
    const expected = new Map<string, string>(), checkpoints: { id: string; version: string; expected: Map<string, string> }[] = [];
    let forkExpected = new Map<string, string>();
    const requestHash = createHash("sha256").update("soak").digest("hex");
    let rollbacks = 0, peakRss = 0, peakHeap = 0, peakObjects = 0, peakObjectBytes = 0;
    const maintenance = { calls: 0, removed: 0, bytes: 0, remaining: false, maxCallMs: 0 };
    const samples: { operation: number; objects: number; objectBytes: number; metadataBytes: number; databaseBytes: number; walBytes: number }[] = [];
    const check = (version: string, model: Map<string, string>) => {
      const state = readVersion(objects, version), page = tree.page(state.transcriptRoot);
      if (page.next || page.entries.length !== model.size) throw new Error("Snapshot size disagrees with the independent oracle.");
      for (const entry of page.entries)
        if (objects.get(entry.value, "chunk").bytes.toString() !== model.get(entry.key)) throw new Error("Snapshot content disagrees with the independent oracle.");
    };
    const collect = () => {
      const start = performance.now(), result = collector.collect();
      maintenance.calls++; maintenance.removed += result.removed; maintenance.bytes += result.bytes;
      maintenance.remaining = result.remaining; maintenance.maxCallMs = Math.max(maintenance.maxCallMs, performance.now() - start);
    };
    const start = performance.now();
    for (let n = 0; n < operations; n++) {
      const key = `k${n % 20}`, text = `value-${n}:`.padEnd(1024, "x");
      atomicVersionWrite(db, () => {
        root = tree.update(root, [{ key, value: objects.put("chunk", Buffer.from(text)) }]);
        const version = createVersion(objects, { transcriptRoot: root });
        head = heads.publish({ sessionId: "soak", versionId: version, expectedRevision: head.revision, expectedEpoch: head.epoch });
        expected.set(key, text);
        if (n % 37 === 0) {
          const id = `cp-${n}`;
          pins.hold({ id, objectId: version, kind: "checkpoint", owner: "soak-cp" });
          checkpoints.push({ id, version, expected: new Map(expected) });
          if (checkpoints.length > 3) pins.release(checkpoints.shift()!.id, "soak-cp");
        }
      });
      const readerVersion = head.versionId, readerExpected = new Map(expected), reader = `reader-${n}`;
      pins.hold({ id: reader, objectId: readerVersion, kind: "reader", owner: reader });
      if (!fork) {
        fork = heads.fork({ sourceSessionId: "soak", targetSessionId: "soak-fork", versionId: head.versionId, expectedRevision: head.revision, requestId: "fork", requestHash });
        forkExpected = new Map(expected);
      } else if (n % 41 === 0) {
        fork = heads.publish({ sessionId: "soak-fork", versionId: head.versionId, expectedRevision: fork.revision, expectedEpoch: fork.epoch });
        forkExpected = new Map(expected);
      }
      if ((n + 1) % 5 === 0) {
        head = heads.switch({ sessionId: "soak", targetVersionId: base, expectedRevision: head.revision, requestId: `undo-${n}`, requestHash });
        root = null; expected.clear(); rollbacks++;
      }
      // The reader survives a head switch and concurrent-style reclamation.
      collect(); check(readerVersion, readerExpected); pins.release(reader, reader);
      collect(); check(head.versionId, expected);
      const stats = objects.stats(), memory = process.memoryUsage();
      peakObjects = Math.max(peakObjects, stats.objects); peakObjectBytes = Math.max(peakObjectBytes, stats.bytes);
      peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed);
      if ((n + 1) % Math.max(1, Math.ceil(operations / 100)) === 0 || n + 1 === operations) {
        const disk = resources.disk();
        samples.push({ operation: n + 1, objects: stats.objects, objectBytes: stats.bytes, metadataBytes: resources.metadata().bytes, databaseBytes: disk.databaseBytes, walBytes: disk.walBytes });
      }
    }
    for (let batch = 0; maintenance.remaining && batch < 10000; batch++) collect();
    if (maintenance.remaining) throw new Error("Collector failed to finish within the soak drain budget.");
    for (const checkpoint of checkpoints) check(checkpoint.version, checkpoint.expected);
    if (fork) check(heads.read(fork.sessionId).versionId, forkExpected);
    return {
      scope: "version-core-soak-only", endToEndAccepted: false, timestamp: new Date().toISOString(),
      operations, rollbacks, durationMs: performance.now() - start, retainedCheckpointsVerified: checkpoints.length, forkVerified: Boolean(fork),
      maintenance, peakObjects, peakObjectBytes, memory: { peakRss, peakHeap, processMaxRssKiB: process.resourceUsage().maxRSS },
      final: { objects: objects.stats(), metadata: resources.metadata(), disk: resources.disk() }, samples,
      environment: { node: process.version, cpu: os.cpus()[0]?.model, platform: process.platform, execArgv: process.execArgv },
      notes: ["Only version-core operations; no runtime/UI/file compensation/legacy migration acceptance.", "Reader pins survive root switches; three historical checkpoint pins plus one fork are retained and verified.", "Idempotency results intentionally remain and consume a finite metadata budget; immutable content, not all control metadata, is expected to plateau.", "Disk footprint includes allocated/freelist/WAL/SHM; releasing logical bytes does not promise immediate filesystem shrink."],
    };
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}
try {
  const config = options(), report = run(config.operations), json = JSON.stringify(report, null, 2) + "\n";
  if (config.output) writeFileSync(config.output, json, { flag: "wx" });
  else process.stdout.write(json);
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
