import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = {
  CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY,
  DATA_ROOT: process.env.DATA_ROOT,
};

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Synax-config-store-"));
  process.env.DATA_ROOT = tempDir;
  process.env.CONFIG_ENCRYPTION_KEY = "unit-test-secret";
  vi.restoreAllMocks();
  vi.resetModules();
});

afterEach(async () => {
  const dbModule = await import("../../../db/index.js");
  dbModule.closeDb();
  vi.restoreAllMocks();
  vi.resetModules();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  process.env.DATA_ROOT = originalEnv.DATA_ROOT;
  process.env.CONFIG_ENCRYPTION_KEY = originalEnv.CONFIG_ENCRYPTION_KEY;
});

describe("config-store migration and overrides", () => {
  it("defaults archive cleanup to seven days and preserves custom or disabled values", async () => {
    const { getGlobalConfig, updateGlobalConfig } = await import("../config-store.js");
    expect(getGlobalConfig().sessionArchiveRetentionDays).toBe(7);
    updateGlobalConfig({ sessionArchiveRetentionDays: 30 }, "tester");
    expect(getGlobalConfig().sessionArchiveRetentionDays).toBe(30);
    updateGlobalConfig({ sessionArchiveRetentionDays: null }, "tester");
    expect(getGlobalConfig().sessionArchiveRetentionDays).toBeNull();
  });

  it("encrypts web-search API and OAuth secrets while exposing masks to settings", async () => {
    const { getGlobalConfig, getGlobalConfigForRuntime, updateGlobalConfig } =
      await import("../config-store.js");
    updateGlobalConfig(
      {
        webSearch: {
          routing: "local",
          remote: { externalWebAccess: true, searchContextSize: "medium" },
          local: {
            engine: "custom",
            endpoint: "https://search.example.com/v1/search",
            auth: {
              type: "oauth2",
              authorizationUrl: "https://search.example.com/oauth/authorize",
              tokenUrl: "https://search.example.com/oauth/token",
              clientId: "client-id",
              clientSecret: "client-secret-value",
              accessToken: "access-token-value",
              refreshToken: "refresh-token-value",
            },
          },
        },
      },
      "tester",
    );

    const display = getGlobalConfig().webSearch.local.auth;
    expect(display.clientSecret).toBeUndefined();
    expect(display.accessToken).toBeUndefined();
    expect(display.refreshToken).toBeUndefined();
    expect(display.accessTokenMasked).toContain("****");
    expect(getGlobalConfigForRuntime().webSearch.local.auth.accessToken).toBe(
      "access-token-value",
    );

    const raw = fs.readFileSync(
      path.join(tempDir, "config", "global-config.json"),
      "utf8",
    );
    expect(raw).not.toContain("client-secret-value");
    expect(raw).not.toContain("access-token-value");
    expect(raw).not.toContain("refresh-token-value");
    expect(raw).toContain("enc:v1:");
  });

  it("migrates legacy API provider fields and masks secrets in display config", async () => {
    const dbModule = await import("../../../db/index.js");
    const { getGlobalConfig } = await import("../config-store.js");

    const sqlite = dbModule.getRawSqlite();
    const legacyConfig = {
      version: 1,
      providers: [],
      defaultProviderId: "opencode-acp",
      defaultApiProviderId: "anthropic",
      enabledAcpProviderIds: ["opencode-acp"],
      providerConnections: {
        anthropic: {
          providerId: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "legacy-anthropic-key",
          extra: {
            model: "claude-3-5-sonnet-latest",
          },
        },
      },
      limits: {
        maxAgentsPerProject: 10,
        agentTimeoutMs: 300000,
      },
      features: {
        allowProjectConnectionOverride: true,
      },
      updatedAt: "2026-05-13T00:00:00.000Z",
      updatedBy: "legacy",
    };

    sqlite
      .prepare(
        `INSERT INTO global_config (id, version, config_json, updated_at, updated_by)
       VALUES (1, ?, ?, ?, ?)`,
      )
      .run(
        1,
        JSON.stringify(legacyConfig),
        legacyConfig.updatedAt,
        legacyConfig.updatedBy,
      );

    const config = getGlobalConfig();
    expect(config.defaultApiProviderId).toBe("anthropic");
    expect(
      config.providers.some((provider) => provider.id === "anthropic"),
    ).toBe(true);
    expect(config.providers.some((provider) => provider.id === "openai")).toBe(
      true,
    );

    const anthropicConnection = config.providerConnections.anthropic;
    expect(anthropicConnection.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(anthropicConnection.apiKey).toBeUndefined();
    expect(typeof anthropicConnection.apiKeyMasked).toBe("string");
    expect(anthropicConnection.apiKeyMasked).not.toContain(
      "legacy-anthropic-key",
    );
  });

  it("keeps secrets encrypted at rest and merges project overrides over global config", async () => {
    const {
      getEffectiveConfig,
      getGlobalConfig,
      getProjectConfig,
      updateGlobalConfig,
      upsertProjectConfig,
    } = await import("../config-store.js");

    updateGlobalConfig(
      {
        defaultApiProviderId: "openai",
        providerConnections: {
          openai: {
            providerId: "openai",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-global-12345678",
            extra: {
              kind: "api",
              apiFormat: "openai",
              model: "gpt-4o-mini",
            },
          },
        },
      },
      "tester",
    );

    upsertProjectConfig(
      "project-alpha",
      {
        providerId: "openai",
        modelId: "gpt-4o-mini",
        providerConnection: {
          providerId: "openai",
          baseUrl: "https://override.internal/v1",
        },
      },
      "tester",
    );

    const globalDisplay = getGlobalConfig();
    const projectDisplay = getProjectConfig("project-alpha");
    const effective = getEffectiveConfig("project-alpha");

    expect(globalDisplay.providerConnections.openai.apiKey).toBeUndefined();
    expect(typeof globalDisplay.providerConnections.openai.apiKeyMasked).toBe(
      "string",
    );
    expect(projectDisplay?.providerConnection?.apiKey).toBeUndefined();
    expect(effective.providerId).toBe("openai");
    expect(effective.modelId).toBe("gpt-4o-mini");
    expect(effective.connection.baseUrl).toBe("https://override.internal/v1");
    expect(effective.connection.apiKey).toBe("sk-global-12345678");

    const globalConfigPath = path.join(tempDir, "config", "global-config.json");
    const templateConfigPath = path.join(
      tempDir,
      "config",
      "template-config.json",
    );
    const rawGlobal = fs.readFileSync(globalConfigPath, "utf8");
    const rawTemplate = fs.readFileSync(templateConfigPath, "utf8");
    expect(rawGlobal).not.toContain("sk-global-12345678");
    expect(rawTemplate).toContain("enc:v1:");
  });
});

describe("config-store provider model metadata persistence", () => {
  it("keeps per-model contextLimit and allowed reasoning efforts across save/load", async () => {
    const { getGlobalConfig, updateGlobalConfig } =
      await import("../config-store.js");

    const provider = {
      id: "custom-api:deepseek",
      label: "DeepSeek",
      status: "live" as const,
      kind: "api" as const,
      caps: { canFollowUp: true, canCancel: true },
      models: [
        {
          id: "deepseek-chat",
          label: "deepseek-chat",
          isDefault: true,
          contextLimit: 1_000_000,
        },
        { id: "deepseek-reasoner", label: "deepseek-reasoner" },
      ],
    };
    updateGlobalConfig(
      {
        providers: [provider],
        providerConnections: {
          "custom-api:deepseek": {
            providerId: "custom-api:deepseek",
            baseUrl: "https://api.deepseek.com",
            apiKey: "sk-1234567890abcdef",
            extra: {
              kind: "api",
              apiFormat: "openai",
              model: "deepseek-chat",
              reasoningEfforts: ["high", "max"],
            },
          },
        },
      },
      "tester",
    );

    const config = getGlobalConfig();
    const saved = config.providers.find((p) => p.id === "custom-api:deepseek");
    expect(
      saved?.models.find((m) => m.id === "deepseek-chat")?.contextLimit,
    ).toBe(1_000_000);
    expect(
      saved?.models.find((m) => m.id === "deepseek-reasoner")?.contextLimit,
    ).toBeUndefined();
    expect(
      config.providerConnections["custom-api:deepseek"]?.extra
        ?.reasoningEfforts,
    ).toEqual(["high", "max"]);
  });
});

describe("config-store ACP providers (codex & pi)", () => {
  it("ships codex-acp and pi-acp as official built-in ACP providers", async () => {
    const { getGlobalConfig } = await import("../config-store.js");
    const config = getGlobalConfig();
    const ids = new Set(config.providers.map((p) => p.id));
    expect(ids).toContain("codex-acp");
    expect(ids).toContain("pi-acp");
    const codex = config.providers.find((p) => p.id === "codex-acp");
    expect(codex?.kind).toBe("acp");
    expect(config.providerConnections["codex-acp"]?.extra?.kind).toBe("acp");
    expect(config.providerConnections["pi-acp"]?.extra?.kind).toBe("acp");
  });

  it("keeps codex-acp as defaultProviderId through save/load normalization", async () => {
    const { getGlobalConfig, updateGlobalConfig } =
      await import("../config-store.js");
    updateGlobalConfig({ defaultProviderId: "codex-acp" }, "tester");
    expect(getGlobalConfig().defaultProviderId).toBe("codex-acp");
  });

  it("injects newly added built-in ACP providers into older persisted templates", async () => {
    const { getGlobalConfig } = await import("../config-store.js");
    // First access initializes the store files, then we simulate an older
    // template that predates codex-acp / pi-acp.
    getGlobalConfig();
    const templatePath = path.join(tempDir, "config", "template-config.json");
    const raw = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    raw.providers = raw.providers.filter(
      (p: { id: string }) => p.id !== "codex-acp" && p.id !== "pi-acp",
    );
    fs.writeFileSync(templatePath, JSON.stringify(raw));

    const config = getGlobalConfig();
    const ids = new Set(config.providers.map((p) => p.id));
    expect(ids).toContain("codex-acp");
    expect(ids).toContain("pi-acp");
  });
});
