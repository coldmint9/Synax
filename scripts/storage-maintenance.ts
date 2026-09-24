import fs from "node:fs";
import path from "node:path";
import NativeDatabase from "libsql";
import { DATA_ROOT } from "../api/lib/env.js";
import { applyMaintenance, assertRuntimeOffline, planMaintenance, reportStorage } from "../api/services/storage/storage-maintenance.js";

const args = new Set(process.argv.slice(2));
const dbPath = process.env.SYNAX_DB_PATH ?? path.join(DATA_ROOT, "context.db");
const apply = args.has("--apply");
const compact = args.has("--compact");
const backup = process.env.SYNAX_STORAGE_BACKUP ?? `${dbPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.backup.db`;

function sqlPath(file: string): string { return file.replace(/'/g, "''"); }
function open(readonly: boolean): NativeDatabase.Database { return new NativeDatabase(dbPath, { readonly }); }

const observation = open(true);
const before = reportStorage(observation, dbPath);
const plan = planMaintenance(observation);
observation.close();
console.log(JSON.stringify({ report: before, plan, mode: apply || compact ? "mutating" : "dry-run" }, null, 2));

if (apply || compact) {
  if (fs.existsSync(backup)) throw new Error(`Backup already exists; refusing to overwrite: ${backup}`);
  const source = open(false);
  try {
    assertRuntimeOffline(source);
    // VACUUM INTO is the consistent SQLite snapshot; it includes committed WAL state.
    source.exec(`VACUUM INTO '${sqlPath(backup)}'`);
    if (apply) console.log(JSON.stringify({ applied: applyMaintenance(source, planMaintenance(source)), backup }, null, 2));
    if (compact) {
      const result = String((source.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check);
      if (result !== "ok") throw new Error(`Integrity check failed before compact: ${result}`);
      source.exec("VACUUM");
      const after = String((source.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check);
      if (after !== "ok") throw new Error(`Integrity check failed after compact: ${after}`);
    }
  } finally { source.close(); }
  const finalDb = open(true);
  try { console.log(JSON.stringify({ final: reportStorage(finalDb, dbPath), backup }, null, 2)); }
  finally { finalDb.close(); }
}
