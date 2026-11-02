import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The import reads CC Switch's own SQLite file and writes through the regular
 * config store, so both roots are redirected into a temp sandbox first.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cc-switch-routes-"));
const DATA_ROOT = path.join(ROOT, "data");
const CC_SWITCH_HOME = path.join(ROOT, "cc-switch");
const CLAUDE_KEY = "sk-ant-abcdefghijklmnop";
const CODEX_KEY = "sk-openai-abcdefghijklmnop";

process.env.DATA_ROOT = DATA_ROOT;
process.env.CC_SWITCH_HOME = CC_SWITCH_HOME;

const CC_SWITCH_SCHEMA = `
  CREATE TABLE providers (
    id TEXT NOT NULL,
    app_type TEXT NOT NULL,
    name TEXT NOT NULL,
    settings_config TEXT NOT NULL,
    category TEXT,
    sort_index INTEGER,
    meta TEXT NOT NULL DEFAULT '{}',
    is_current BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (id, app_type)
  )
`;

beforeAll(async () => {
  fs.mkdirSync(CC_SWITCH_HOME, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(CC_SWITCH_HOME, "cc-switch.db"));
  db.exec(CC_SWITCH_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO providers (id, app_type, name, settings_config, category, sort_index, meta, is_current)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rows: Array<[string, string, string, unknown, string | null, number, unknown, number]> = [
    [
      "claude-gateway",
      "claude",
      "My Gateway",
      {
        env: {
          ANTHROPIC_BASE_URL: "https://gateway.example.test",
          ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY,
          ANTHROPIC_MODEL: "claude-sonnet-5",
        },
      },
      null,
      0,
      { apiFormat: "anthropic" },
      1,
    ],
    [
      "claude-official",
      "claude",
      "Claude Official",
      { env: {} },
      "official",
      1,
      {},
      0,
    ],
    [
      "codex-rabbit",
      "codex",
      "Rabbit",
      {
        auth: { OPENAI_API_KEY: CODEX_KEY },
        config: 'model = "gpt-6-sol"\n\n[model_providers.custom]\nbase_url = "https://rabbit.example.test/v1"\nwire_api = "responses"\n',
      },
      null,
      0,
      { apiFormat: "openai_responses" },
      0,
    ],
    [
      "hermes-1",
      "hermes",
      "Hermes",
      { base_url: "https://hermes.example.test", api_key: "sk-hermes" },
      null,
      0,
      {},
      0,
    ],
  ];
  for (const [id, appType, name, settingsConfig, category, sortIndex, meta, isCurrent] of rows) {
    insert.run(
      id,
      appType,
      name,
      JSON.stringify(settingsConfig),
      category,
      sortIndex,
      JSON.stringify(meta),
      isCurrent,
    );
  }
  db.close();
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function readGlobalConfigFile(): { providerConnections?: Record<string, { apiKey?: string; apiKeyMasked?: string }> } {
  return JSON.parse(
    fs.readFileSync(path.join(DATA_ROOT, "config", "global-config.json"), "utf8"),
  );
}

describe("cc-switch import routes", () => {
  it("previews supported providers without leaking API keys", async () => {
    const { configRoutes } = await import("../config.js");
    const response = await configRoutes.request("http://localhost/providers/cc-switch");
    const text = await response.clone().text();
    const body = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.sourcePath).toBe(path.join(CC_SWITCH_HOME, "cc-switch.db"));
    expect(body.items.map((item: { key: string }) => item.key)).toEqual([
      "claude:claude-gateway",
      "codex:codex-rabbit",
    ]);
    expect(body.items[0]).toEqual(
      expect.objectContaining({
        appType: "claude",
        label: "My Gateway",
        apiFormat: "anthropic",
        conflict: "none",
        selectable: true,
      }),
    );
    expect(body.items[0].apiKeyMasked).toContain("****");
    expect(body.items[0].declaredModels).toEqual(["claude-sonnet-5"]);
    expect(body.items[1]).toEqual(
      expect.objectContaining({ apiFormat: "openai-responses", defaultModel: "gpt-6-sol" }),
    );
    expect(body.unsupported).toEqual([
      expect.objectContaining({ key: "hermes:hermes-1" }),
    ]);
    expect(body.skipped).toEqual([
      expect.objectContaining({ key: "claude:claude-official" }),
    ]);
    // Neither the raw keys nor the whole row payload may reach the browser.
    expect(text).not.toContain(CLAUDE_KEY);
    expect(text).not.toContain(CODEX_KEY);
  });

  it("imports a provider, encrypts its key and stays idempotent", async () => {
    const { configRoutes } = await import("../config.js");
    const payload = JSON.stringify({
      keys: ["claude:claude-gateway", "codex:codex-rabbit"],
      validate: false,
    });

    const first = await configRoutes.request("http://localhost/providers/cc-switch/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const firstBody = await first.json();

    expect(first.status).toBe(200);
    expect(firstBody.imported).toEqual([
      expect.objectContaining({ label: "My Gateway", action: "created" }),
      expect.objectContaining({ label: "Rabbit", action: "created" }),
    ]);

    const importedIds = firstBody.imported.map((item: { providerId: string }) => item.providerId);
    const providerIds = firstBody.config.providers.map((item: { id: string }) => item.id);
    expect(providerIds).toEqual(expect.arrayContaining(importedIds));
    expect(providerIds).toEqual(expect.arrayContaining(["openai", "anthropic"]));

    // Keys are encrypted at rest and only exposed masked.
    const stored = readGlobalConfigFile();
    for (const providerId of importedIds) {
      expect(stored.providerConnections?.[providerId]?.apiKey).toMatch(/^enc:v1:/);
      expect(stored.providerConnections?.[providerId]?.apiKeyMasked).toContain("****");
    }

    const second = await configRoutes.request("http://localhost/providers/cc-switch/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody.imported).toEqual([]);
    expect(secondBody.skipped).toHaveLength(2);
    expect(
      secondBody.config.providers.filter((item: { id: string }) => importedIds.includes(item.id)),
    ).toHaveLength(2);
  });

  it("never returns a plaintext key from the config endpoint", async () => {
    const { configRoutes } = await import("../config.js");
    const response = await configRoutes.request("http://localhost/global");
    const text = await response.clone().text();
    const body = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(text).not.toContain(CLAUDE_KEY);
    expect(text).not.toContain(CODEX_KEY);
    const importedConnections = Object.entries(
      body.config.providerConnections ?? {},
    ).filter(([providerId]) => providerId.startsWith("custom-api:ccsw-"));
    expect(importedConnections).toHaveLength(2);
    for (const [, connection] of importedConnections as Array<[
      string,
      { apiKey?: string; apiKeyMasked?: string },
    ]>) {
      expect(connection.apiKey).toBeUndefined();
      expect(connection.apiKeyMasked).toContain("****");
    }
    // Built-in vendors stay untouched: no key material at all.
    expect(body.config.providerConnections.openai?.apiKey).toBeUndefined();
  });

  it("reports a missing CC Switch database instead of failing", async () => {
    const { configRoutes } = await import("../config.js");
    const previous = process.env.CC_SWITCH_HOME;
    process.env.CC_SWITCH_HOME = path.join(ROOT, "missing");
    try {
      const preview = await configRoutes.request("http://localhost/providers/cc-switch");
      const previewBody = await preview.json();
      expect(preview.status).toBe(200);
      expect(previewBody.available).toBe(false);
      expect(previewBody.items).toEqual([]);

      const imported = await configRoutes.request("http://localhost/providers/cc-switch/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: ["claude:claude-gateway"], validate: false }),
      });
      expect(imported.status).toBe(400);
      expect((await imported.json()).error).toBe("未找到 CC Switch 数据库");
    } finally {
      process.env.CC_SWITCH_HOME = previous;
    }
  });

  it("rejects an empty selection", async () => {
    const { configRoutes } = await import("../config.js");
    const response = await configRoutes.request("http://localhost/providers/cc-switch/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: [] }),
    });

    expect(response.status).toBe(400);
  });
});
