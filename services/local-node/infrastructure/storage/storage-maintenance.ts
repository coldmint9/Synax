import fs from "node:fs";
import path from "node:path";
import NativeDatabase from "libsql";
import { DATA_ROOT } from "../runtime/env.js";

const CACHE_TABLES = new Set<string>();
const FTS_NAMES = new Set(["agent_search_messages", "agent_search_sessions"]);
const CATEGORIES: Record<string, string> = {
  agent_runtime_stream_records: "replay", agent_runtime_events: "events",
  conversation_history_journal: "undo-journal", agent_runtime_processes: "process-receipts",
};
export interface StorageReport {
  path: string; fileBytes: number; walBytes: number; shmBytes: number;
  pageSize: number; pageCount: number; freePages: number; freeBytes: number;
  allocatedBytes: number; integrity: string; categories: Array<{ category: string; bytes: number; payloadBytes: number; names: string[] }>;
  rows: Record<string, number>;
}
export interface MaintenancePlan {
  orphanScanCacheRows: number; orphanScanCacheBytes: number;
  closedOwnerlessProcessRows: number; closedOwnerlessProcessBytes: number;
  replayRows: number; replayBytes: number; replayRetainRows: number;
  ftsTables: string[]; warnings: string[];
}
function fileSize(file: string): number { try { return fs.statSync(file).size; } catch { return 0; } }
function dbstat(db: NativeDatabase.Database) {
  try { return db.prepare("SELECT name,sum(pgsize) AS bytes,sum(payload) AS payloadBytes FROM dbstat GROUP BY name").all() as Array<{ name: string; bytes: number; payloadBytes: number }>; }
  catch { return []; }
}
export function reportStorage(db: NativeDatabase.Database, dbPath: string): StorageReport {
  const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const pageCount = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
  const freePages = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  const categories = new Map<string, { bytes: number; payloadBytes: number; names: string[] }>();
  for (const row of dbstat(db)) {
    const category = FTS_NAMES.has(row.name) || row.name.startsWith("agent_search_") ? "search-index" : CATEGORIES[row.name] ?? "transactional-authority";
    const current = categories.get(category) ?? { bytes: 0, payloadBytes: 0, names: [] };
    current.bytes += row.bytes; current.payloadBytes += row.payloadBytes; if (!current.names.includes(row.name)) current.names.push(row.name); categories.set(category, current);
  }
  const rows: Record<string, number> = {};
  for (const name of ["agent_runtime_events", "agent_runtime_stream_records", "agent_runtime_processes", "conversation_history_journal", "agent_runtime_sessions"]) {
    try { rows[name] = Number((db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n); } catch { /* optional table */ }
  }
  return { path: dbPath, fileBytes: fileSize(dbPath), walBytes: fileSize(`${dbPath}-wal`), shmBytes: fileSize(`${dbPath}-shm`), pageSize, pageCount, freePages, freeBytes: freePages * pageSize, allocatedBytes: (pageCount - freePages) * pageSize, integrity: String((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check), categories: [...categories].map(([category, value]) => ({ category, ...value })).sort((a, b) => b.bytes - a.bytes), rows };
}
function activeProjectIds(dataRoot: string): Set<string> | null {
  try { const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, "projects.json"), "utf8")) as { items?: Array<{ id?: string }> }; return new Set((raw.items ?? []).flatMap(item => typeof item.id === "string" ? [item.id] : [])); } catch { return null; }
}
function sizeOf(db: NativeDatabase.Database, table: string, where = "1=1", args: unknown[] = []): number {
  try { return Number((db.prepare(`SELECT coalesce(sum(length(CAST(result_json AS BLOB))),0) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n); } catch { return 0; }
}
export function planMaintenance(db: NativeDatabase.Database, dataRoot = DATA_ROOT, now = Date.now()): MaintenancePlan {
  const active = activeProjectIds(dataRoot); let orphanScanCacheRows = 0, orphanScanCacheBytes = 0;
  let closedOwnerlessProcessRows = 0, closedOwnerlessProcessBytes = 0;
  try {
    const rows = db.prepare("SELECT count(*) AS n,coalesce(sum(length(command_label)+length(id)),0) AS bytes FROM agent_runtime_processes WHERE state='closed' AND kind='command' AND session_id IS NULL AND ended_at IS NOT NULL AND ended_at<?").get(new Date(now - 30 * 86400_000).toISOString()) as { n: number; bytes: number }; closedOwnerlessProcessRows = rows.n; closedOwnerlessProcessBytes = rows.bytes;
  } catch { /* optional table */ }
  let replayRows = 0, replayBytes = 0, replayRetainRows = 0;
  try {
    const rows = db.prepare("SELECT r.session_id,count(*) AS n,coalesce(sum(length(CAST(r.chunk_json AS BLOB))),0) AS bytes FROM agent_runtime_stream_records r JOIN agent_runtime_sessions s ON s.id=r.session_id WHERE s.status NOT IN ('running','queued','waiting_permission','waiting_input') GROUP BY r.session_id").all() as Array<{ session_id: string; n: number; bytes: number }>;
    replayRows = rows.reduce((sum, row) => sum + Math.max(0, row.n - 1024), 0); replayBytes = rows.reduce((sum, row) => sum + row.bytes, 0); replayRetainRows = rows.length * 1024;
  } catch { /* optional table */ }
  return { orphanScanCacheRows, orphanScanCacheBytes, closedOwnerlessProcessRows, closedOwnerlessProcessBytes, replayRows, replayBytes, replayRetainRows, ftsTables: dbstat(db).map(row => row.name).filter(name => FTS_NAMES.has(name) || name.startsWith("agent_search_")), warnings: ["This plan never deletes authoritative messages, events, checkpoints, billing, undo, fork, or asset rows.", "Apply requires an offline runtime lock check and a consistent backup."] };
}
export function applyMaintenance(db: NativeDatabase.Database, plan: MaintenancePlan, dataRoot = DATA_ROOT, now = Date.now()): { deletedCacheRows: number; deletedProcessRows: number; deletedReplayRows: number; optimizedFts: string[] } {
  const active = activeProjectIds(dataRoot); let deletedCacheRows = 0;
  // No generated-document cache remains after the documentation module removal.
  let deletedProcessRows = 0;
  try { deletedProcessRows = db.prepare("DELETE FROM agent_runtime_processes WHERE state='closed' AND kind='command' AND session_id IS NULL AND ended_at IS NOT NULL AND ended_at<?").run(new Date(now - 30 * 86400_000).toISOString()).changes; } catch { /* optional */ }
  let deletedReplayRows = 0;
  try {
    const sessions = db.prepare("SELECT r.session_id,count(*) AS n FROM agent_runtime_stream_records r JOIN agent_runtime_sessions s ON s.id=r.session_id WHERE s.status NOT IN ('running','queued','waiting_permission','waiting_input') GROUP BY r.session_id").all() as Array<{ session_id: string; n: number }>;
    for (const row of sessions) if (row.n > 1024) deletedReplayRows += db.prepare("DELETE FROM agent_runtime_stream_records WHERE session_id=? AND sequence IN (SELECT sequence FROM agent_runtime_stream_records WHERE session_id=? ORDER BY sequence ASC LIMIT ?)").run(row.session_id, row.session_id, row.n - 1024).changes;
  } catch { /* optional */ }
  const optimizedFts: string[] = [];
  for (const table of plan.ftsTables) { try { db.prepare(`INSERT INTO "${table}"("${table}") VALUES('optimize')`).run(); optimizedFts.push(table); } catch { /* optional/corrupt FTS */ } }
  return { deletedCacheRows, deletedProcessRows, deletedReplayRows, optimizedFts };
}
export function assertRuntimeOffline(db: NativeDatabase.Database, pid = process.pid): void {
  try { const row = db.prepare("SELECT pid FROM runtime_host_lock WHERE id=1").get() as { pid: number } | undefined; if (row && row.pid !== pid) { try { process.kill(row.pid, 0); throw new Error(`Runtime is active under process ${row.pid}; maintenance must run offline.`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } } catch (error) { if (error instanceof Error && /maintenance must run/.test(error.message)) throw error; }
}
