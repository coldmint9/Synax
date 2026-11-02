import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CcSwitchProviderRecord } from "../../modules/llm-providers/cc-switch-contracts.js";

/**
 * Read-only access to CC Switch's SQLite store (`~/.cc-switch/cc-switch.db`).
 *
 * CC Switch keeps every configured provider in its `providers` table, with the
 * CLI-native config payload in the `settings_config` JSON column. This adapter
 * only ever reads: the app's own file is never written, and a locked or
 * unsupported database degrades to a copy of the file (or an explicit error).
 */

const DB_FILE = "cc-switch.db";
const SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

const PROVIDER_QUERY = `
  SELECT app_type, id, name, category, meta, settings_config, is_current, sort_index
  FROM providers
  ORDER BY app_type, sort_index
`;

export interface CcSwitchSourceOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CcSwitchSourceResult {
  available: boolean;
  dbPath: string;
  records: CcSwitchProviderRecord[];
  warnings: string[];
  error?: string;
}

export function resolveCcSwitchDbPath(options: CcSwitchSourceOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? os.homedir();
  const override = env.CC_SWITCH_HOME?.trim();
  const dir = override || path.join(home, ".cc-switch");
  return path.join(dir, DB_FILE);
}

type SqliteModule = typeof import("node:sqlite");

async function loadSqlite(): Promise<SqliteModule> {
  return import("node:sqlite");
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readRows(db: import("node:sqlite").DatabaseSync): {
  records: CcSwitchProviderRecord[];
  warnings: string[];
} {
  const rows = db.prepare(PROVIDER_QUERY).all() as Array<Record<string, unknown>>;
  const records: CcSwitchProviderRecord[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    const settingsConfig = parseJsonColumn(row.settings_config);
    if (settingsConfig === undefined) {
      warnings.push(`${String(row.app_type ?? "?")}:${String(row.id ?? "?")} 的配置无法解析，已跳过`);
      continue;
    }
    const meta = parseJsonColumn(row.meta);
    records.push({
      appType: String(row.app_type ?? ""),
      id: String(row.id ?? ""),
      name: String(row.name ?? ""),
      category: typeof row.category === "string" ? row.category : null,
      isCurrent: Boolean(row.is_current),
      settingsConfig,
      meta:
        meta && typeof meta === "object" && !Array.isArray(meta)
          ? (meta as Record<string, unknown>)
          : {},
    });
  }
  return { records, warnings };
}

async function readDatabase(
  dbPath: string,
  warnings: string[],
): Promise<CcSwitchProviderRecord[]> {
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    const { records, warnings: rowWarnings } = readRows(db);
    warnings.push(...rowWarnings);
    return records;
  } finally {
    db.close();
  }
}

function copyDatabaseToTemp(dbPath: string): { dir: string; file: string } | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-cc-switch-"));
    const target = path.join(dir, DB_FILE);
    fs.copyFileSync(dbPath, target);
    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = `${dbPath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${target}${suffix}`);
    }
    return { dir, file: target };
  } catch {
    return null;
  }
}

function removeQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp cleanup must never mask the real result.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return /sqlite|database/i.test(error.message)
      ? `无法读取 CC Switch 数据库：${error.message}`
      : error.message;
  }
  return String(error);
}

/**
 * Read every provider row. Callers must treat the returned `settings_config`
 * as sensitive: it contains plaintext API keys.
 */
export async function readCcSwitchProviders(
  options: CcSwitchSourceOptions = {},
): Promise<CcSwitchSourceResult> {
  const dbPath = resolveCcSwitchDbPath(options);
  const warnings: string[] = [];
  if (!fs.existsSync(dbPath)) {
    return {
      available: false,
      dbPath,
      records: [],
      warnings,
      error: "未找到 CC Switch 数据库",
    };
  }

  try {
    const records = await readDatabase(dbPath, warnings);
    return { available: true, dbPath, records, warnings };
  } catch (error) {
    // CC Switch writes with journal_mode=delete; a live write can lock the file
    // briefly. Read a copy so a running app never blocks the import.
    const copy = copyDatabaseToTemp(dbPath);
    if (!copy) {
      return {
        available: false,
        dbPath,
        records: [],
        warnings,
        error: errorMessage(error),
      };
    }
    try {
      const records = await readDatabase(copy.file, warnings);
      return { available: true, dbPath, records, warnings };
    } catch (copyError) {
      return {
        available: false,
        dbPath,
        records: [],
        warnings,
        error: errorMessage(copyError),
      };
    } finally {
      removeQuietly(copy.dir);
    }
  }
}
