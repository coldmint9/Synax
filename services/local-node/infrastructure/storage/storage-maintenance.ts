import fs from 'node:fs';
import path from 'node:path';
import NativeDatabase from 'libsql';

const FTS_NAMES = new Set(['agent_search_messages', 'agent_search_sessions']);
const CATEGORIES: Record<string, string> = {
  agent_runtime_events: 'events',
  conversation_history_journal: 'undo-journal',
  agent_runtime_processes: 'process-receipts',
};

export interface StorageReport {
  path: string; fileBytes: number; walBytes: number; shmBytes: number;
  pageSize: number; pageCount: number; freePages: number; freeBytes: number;
  allocatedBytes: number; integrity: string;
  categories: Array<{ category: string; bytes: number; payloadBytes: number; names: string[] }>;
  rows: Record<string, number>;
}

export interface MaintenancePlan {
  orphanScanCacheRows: number;
  orphanScanCacheBytes: number;
  closedOwnerlessProcessRows: number;
  closedOwnerlessProcessBytes: number;
  ftsTables: string[];
  warnings: string[];
}

function fileSize(file: string): number { try { return fs.statSync(file).size; } catch { return 0; } }
function dbstat(db: NativeDatabase.Database) {
  try { return db.prepare('SELECT name,sum(pgsize) AS bytes,sum(payload) AS payloadBytes FROM dbstat GROUP BY name').all() as Array<{ name: string; bytes: number; payloadBytes: number }>; }
  catch { return []; }
}

export function reportStorage(db: NativeDatabase.Database, dbPath: string): StorageReport {
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const freePages = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
  const categories = new Map<string, { bytes: number; payloadBytes: number; names: string[] }>();
  for (const row of dbstat(db)) {
    const category = FTS_NAMES.has(row.name) || row.name.startsWith('agent_search_') ? 'search-index' : CATEGORIES[row.name] ?? 'transactional-authority';
    const current = categories.get(category) ?? { bytes: 0, payloadBytes: 0, names: [] };
    current.bytes += row.bytes; current.payloadBytes += row.payloadBytes;
    if (!current.names.includes(row.name)) current.names.push(row.name);
    categories.set(category, current);
  }
  const rows: Record<string, number> = {};
  for (const name of ['agent_runtime_events', 'agent_runtime_processes', 'conversation_history_journal', 'agent_runtime_sessions']) {
    try { rows[name] = Number((db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n); } catch { /* optional */ }
  }
  return { path: dbPath, fileBytes: fileSize(dbPath), walBytes: fileSize(`${dbPath}-wal`), shmBytes: fileSize(`${dbPath}-shm`), pageSize, pageCount, freePages, freeBytes: freePages * pageSize, allocatedBytes: (pageCount - freePages) * pageSize, integrity: String((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check), categories: [...categories].map(([category, value]) => ({ category, ...value })).sort((a, b) => b.bytes - a.bytes), rows };
}

export function planMaintenance(db: NativeDatabase.Database, _dataRoot?: string, now = Date.now()): MaintenancePlan {
  let closedOwnerlessProcessRows = 0;
  let closedOwnerlessProcessBytes = 0;
  try {
    const row = db.prepare("SELECT count(*) AS n,coalesce(sum(length(command_label)+length(id)),0) AS bytes FROM agent_runtime_processes WHERE state='closed' AND kind='command' AND session_id IS NULL AND ended_at IS NOT NULL AND ended_at<?").get(new Date(now - 30 * 86400_000).toISOString()) as { n: number; bytes: number };
    closedOwnerlessProcessRows = row.n; closedOwnerlessProcessBytes = row.bytes;
  } catch { /* optional */ }
  return {
    orphanScanCacheRows: 0,
    orphanScanCacheBytes: 0,
    closedOwnerlessProcessRows,
    closedOwnerlessProcessBytes,
    ftsTables: dbstat(db).map(row => row.name).filter(name => FTS_NAMES.has(name) || name.startsWith('agent_search_')),
    warnings: ['Rust authoritative runtime owns replay retention.', 'Apply requires an offline runtime lock check and a consistent backup.'],
  };
}

export function applyMaintenance(db: NativeDatabase.Database, plan: MaintenancePlan, _dataRoot?: string, now = Date.now()): { deletedCacheRows: number; deletedProcessRows: number; deletedReplayRows: number; optimizedFts: string[] } {
  let deletedProcessRows = 0;
  try { deletedProcessRows = db.prepare("DELETE FROM agent_runtime_processes WHERE state='closed' AND kind='command' AND session_id IS NULL AND ended_at IS NOT NULL AND ended_at<?").run(new Date(now - 30 * 86400_000).toISOString()).changes; } catch { /* optional */ }
  const optimizedFts: string[] = [];
  for (const table of plan.ftsTables) { try { db.prepare(`INSERT INTO "${table}"("${table}") VALUES('optimize')`).run(); optimizedFts.push(table); } catch { /* optional/corrupt FTS */ } }
  return { deletedCacheRows: 0, deletedProcessRows, deletedReplayRows: 0, optimizedFts };
}

export function assertRuntimeOffline(db: NativeDatabase.Database, pid = process.pid): void {
  try {
    const row = db.prepare('SELECT pid FROM runtime_host_lock WHERE id=1').get() as { pid: number } | undefined;
    if (row && row.pid !== pid) {
      try { process.kill(row.pid, 0); throw new Error(`Runtime is active under process ${row.pid}; maintenance must run offline.`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  } catch (error) { if (error instanceof Error && /maintenance must run/.test(error.message)) throw error; }
}
