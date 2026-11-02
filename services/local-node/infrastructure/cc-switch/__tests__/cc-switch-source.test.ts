import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCcSwitchProviders, resolveCcSwitchDbPath } from "../cc-switch-source.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-switch-source-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SCHEMA = `
  CREATE TABLE providers (
    id TEXT NOT NULL,
    app_type TEXT NOT NULL,
    name TEXT NOT NULL,
    settings_config TEXT NOT NULL,
    website_url TEXT,
    category TEXT,
    created_at INTEGER,
    sort_index INTEGER,
    notes TEXT,
    icon TEXT,
    icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
    cost_multiplier TEXT NOT NULL DEFAULT '1.0',
    limit_daily_usd TEXT,
    limit_monthly_usd TEXT,
    provider_type TEXT,
    PRIMARY KEY (id, app_type)
  )
`;

interface RowInput {
  id: string;
  appType: string;
  name: string;
  settingsConfig: string;
  category?: string | null;
  meta?: string;
  isCurrent?: number;
  sortIndex?: number;
}

async function writeCcSwitchDb(dir: string, rows: RowInput[]): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = path.join(dir, "cc-switch.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const insert = db.prepare(`
    INSERT INTO providers (id, app_type, name, settings_config, category, meta, is_current, sort_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.appType,
      row.name,
      row.settingsConfig,
      row.category ?? null,
      row.meta ?? "{}",
      row.isCurrent ?? 0,
      row.sortIndex ?? 0,
    );
  }
  db.close();
  return dbPath;
}

describe("cc-switch source", () => {
  it("resolves the default database path under the home directory", () => {
    expect(resolveCcSwitchDbPath({ homeDir: "/tmp/home", env: {} })).toBe(
      "/tmp/home/.cc-switch/cc-switch.db",
    );
    expect(
      resolveCcSwitchDbPath({ homeDir: "/tmp/home", env: { CC_SWITCH_HOME: "/tmp/override" } }),
    ).toBe("/tmp/override/cc-switch.db");
    expect(
      resolveCcSwitchDbPath({ homeDir: "/tmp/home", env: { CC_SWITCH_HOME: "  " } }),
    ).toBe("/tmp/home/.cc-switch/cc-switch.db");
  });

  it("reports a missing database instead of throwing", async () => {
    const home = tempDir();
    const result = await readCcSwitchProviders({ homeDir: home, env: {} });

    expect(result.available).toBe(false);
    expect(result.records).toEqual([]);
    expect(result.error).toBe("未找到 CC Switch 数据库");
  });

  it("reads provider rows and keeps their JSON columns parsed", async () => {
    const home = tempDir();
    const dir = path.join(home, ".cc-switch");
    fs.mkdirSync(dir);
    await writeCcSwitchDb(dir, [
      {
        id: "claude-gateway",
        appType: "claude",
        name: "Gateway",
        settingsConfig: JSON.stringify({
          env: { ANTHROPIC_BASE_URL: "https://gw.example.test", ANTHROPIC_AUTH_TOKEN: "sk-live" },
        }),
        meta: JSON.stringify({ apiFormat: "anthropic" }),
        isCurrent: 1,
      },
    ]);

    const result = await readCcSwitchProviders({ homeDir: home, env: {} });

    expect(result.available).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.appType).toBe("claude");
    expect(record.id).toBe("claude-gateway");
    expect(record.name).toBe("Gateway");
    expect(record.isCurrent).toBe(true);
    expect(record.meta).toEqual({ apiFormat: "anthropic" });
    expect(record.settingsConfig).toEqual({
      env: { ANTHROPIC_BASE_URL: "https://gw.example.test", ANTHROPIC_AUTH_TOKEN: "sk-live" },
    });
  });

  it("honours CC_SWITCH_HOME", async () => {
    const dir = tempDir();
    await writeCcSwitchDb(dir, [
      {
        id: "codex-1",
        appType: "codex",
        name: "Codex",
        settingsConfig: JSON.stringify({ auth: { OPENAI_API_KEY: "sk-fixture" } }),
      },
    ]);

    const result = await readCcSwitchProviders({
      homeDir: tempDir(),
      env: { CC_SWITCH_HOME: dir },
    });

    expect(result.available).toBe(true);
    expect(result.records.map((record) => record.id)).toEqual(["codex-1"]);
  });

  it("skips unparsable rows with a warning and keeps the rest", async () => {
    const dir = tempDir();
    await writeCcSwitchDb(dir, [
      {
        id: "broken",
        appType: "claude",
        name: "Broken",
        settingsConfig: "{not json",
      },
      {
        id: "ok",
        appType: "claude",
        name: "Ok",
        settingsConfig: JSON.stringify({ env: {} }),
      },
    ]);

    const result = await readCcSwitchProviders({ env: { CC_SWITCH_HOME: dir } });

    expect(result.available).toBe(true);
    expect(result.records.map((record) => record.id)).toEqual(["ok"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("broken");
  });

  it("leaves the source database untouched", async () => {
    const dir = tempDir();
    const dbPath = await writeCcSwitchDb(dir, [
      {
        id: "claude-1",
        appType: "claude",
        name: "Keep",
        settingsConfig: JSON.stringify({ env: {} }),
      },
    ]);
    const before = fs.statSync(dbPath);

    await readCcSwitchProviders({ env: { CC_SWITCH_HOME: dir } });

    const after = fs.statSync(dbPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
