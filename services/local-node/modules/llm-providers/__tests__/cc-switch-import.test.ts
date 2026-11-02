import { describe, expect, it } from "vitest";
import { BUILTIN_PROVIDERS, createDefaultUserGlobalConfig } from "../../../infrastructure/runtime/config/config-defaults.js";
import type { GlobalConfig } from "../../../infrastructure/runtime/config/config-types.js";
import {
  buildPreview,
  ccSwitchProviderId,
  importCcSwitchProviders,
  normalizeEndpoint,
  planImport,
} from "../cc-switch-import.js";
import { mapCcSwitchRecords } from "../cc-switch-mapping.js";
import type { CcSwitchProviderRecord } from "../cc-switch-contracts.js";

const CLAUDE_KEY = "sk-ant-abcdefghijklmnop";

function configWith(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    ...createDefaultUserGlobalConfig("test"),
    providers: BUILTIN_PROVIDERS.map((provider) => ({ ...provider })),
    providerConnections: {},
    ...overrides,
  };
}

function claudeRecord(overrides: Partial<CcSwitchProviderRecord> = {}): CcSwitchProviderRecord {
  return {
    appType: "claude",
    id: "claude-gateway-1",
    name: "My Gateway",
    category: null,
    isCurrent: true,
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://gateway.example.test/",
        ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY,
        ANTHROPIC_MODEL: "deepseek-v4-flash[1M]",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flashx",
      },
    },
    meta: { apiFormat: "anthropic" },
    ...overrides,
  };
}

const EXPECTED_ID = ccSwitchProviderId("claude", "claude-gateway-1");

describe("cc-switch import", () => {
  it("normalizes endpoints for conflict detection", () => {
    expect(normalizeEndpoint(" https://Gateway.Example.test/ ")).toBe(
      "https://gateway.example.test",
    );
    expect(normalizeEndpoint(undefined)).toBe("");
  });

  it("creates a provider and its connection without probing", async () => {
    const result = await importCcSwitchProviders({
      config: configWith(),
      records: [claudeRecord()],
      keys: ["claude:claude-gateway-1"],
      validate: false,
    });

    expect(result.skipped).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.imported).toEqual([
      { providerId: EXPECTED_ID, label: "My Gateway", action: "created" },
    ]);

    const provider = result.patch.providers?.find((item) => item.id === EXPECTED_ID);
    expect(provider).toBeTruthy();
    expect(provider?.status).toBe("live");
    expect(provider?.models.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "glm-5.3-flashx",
    ]);
    expect(provider?.models[0]).toEqual(
      expect.objectContaining({ id: "deepseek-v4-flash", isDefault: true, contextLimit: 1_000_000 }),
    );

    const connection = result.patch.providerConnections?.[EXPECTED_ID];
    expect(connection).toEqual({
      providerId: EXPECTED_ID,
      baseUrl: "https://gateway.example.test",
      apiKey: CLAUDE_KEY,
      extra: expect.objectContaining({
        kind: "api",
        apiFormat: "anthropic",
        model: "deepseek-v4-flash",
        ccSwitch: expect.objectContaining({ appType: "claude", id: "claude-gateway-1" }),
      }),
    });
    // The built-in providers must survive the patch: the route replaces the list.
    expect(result.patch.providers?.map((item) => item.id)).toEqual(
      expect.arrayContaining(["openai", "anthropic"]),
    );
    expect(result.patch.defaultApiProviderId).toBe(EXPECTED_ID);
  });

  it("uses the probed models and resolved base URL when validation succeeds", async () => {
    const result = await importCcSwitchProviders({
      config: configWith(),
      records: [claudeRecord()],
      keys: ["claude:claude-gateway-1"],
      validate: true,
      discover: async () => ({
        ok: true,
        models: ["claude-sonnet-5", "deepseek-v4-flash", "text-embedding-3-large", "gpt-image-1"],
        modelMetadata: { "claude-sonnet-5": { contextLimit: 200_000, inputModalities: ["text", "image"] } },
        source: "anthropic/models",
        resolvedBaseUrl: "https://gateway.example.test/v1",
      }),
    });

    expect(result.warnings).toEqual([]);
    const provider = result.patch.providers?.find((item) => item.id === EXPECTED_ID);
    // Embedding and image models cannot serve chat turns, so they are dropped.
    expect(provider?.models.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "deepseek-v4-flash",
    ]);
    expect(provider?.models[0]).toEqual(
      expect.objectContaining({ contextLimit: 200_000, inputModalities: ["text", "image"] }),
    );
    // The declared default model is kept because the endpoint also serves it.
    expect(provider?.models.find((model) => model.isDefault)?.id).toBe("deepseek-v4-flash");
    expect(result.patch.providerConnections?.[EXPECTED_ID]?.baseUrl).toBe(
      "https://gateway.example.test/v1",
    );
  });

  it("falls back to the declared models when the probe fails", async () => {
    const result = await importCcSwitchProviders({
      config: configWith(),
      records: [claudeRecord()],
      keys: ["claude:claude-gateway-1"],
      validate: true,
      discover: async () => ({
        ok: false,
        models: [],
        source: "anthropic/models",
        error: "认证失败 (401)",
      }),
    });

    expect(result.warnings).toEqual([expect.stringContaining("认证失败 (401)")]);
    const provider = result.patch.providers?.find((item) => item.id === EXPECTED_ID);
    expect(provider?.models.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "glm-5.3-flashx",
    ]);
  });

  it("skips a provider that was already imported", async () => {
    const imported = await importCcSwitchProviders({
      config: configWith(),
      records: [claudeRecord()],
      keys: ["claude:claude-gateway-1"],
      validate: false,
    });
    const afterFirstImport = configWith({
      providers: imported.patch.providers ?? [],
      providerConnections: {
        [EXPECTED_ID]: {
          providerId: EXPECTED_ID,
          baseUrl: "https://gateway.example.test",
          apiKeyMasked: "sk-a****mnop",
        },
      },
    });

    const second = await importCcSwitchProviders({
      config: afterFirstImport,
      records: [claudeRecord()],
      keys: ["claude:claude-gateway-1"],
      validate: false,
    });

    expect(second.imported).toEqual([]);
    expect(second.skipped).toEqual([
      { providerId: EXPECTED_ID, label: "My Gateway", action: "skipped", reason: "已导入过" },
    ]);
    expect(second.patch.providerConnections).toEqual({});
  });

  it("updates the existing provider in place when the policy is replace", async () => {
    const existing = configWith({
      providers: [
        ...BUILTIN_PROVIDERS,
        {
          id: EXPECTED_ID,
          label: "Renamed by user",
          status: "live",
          kind: "api",
          caps: { canFollowUp: true, canCancel: true },
          models: [{ id: "old-model", label: "old-model" }],
        },
      ],
      providerConnections: {
        [EXPECTED_ID]: {
          providerId: EXPECTED_ID,
          baseUrl: "https://gateway.example.test",
          apiKeyMasked: "sk-a****mnop",
          extra: { kind: "api", apiFormat: "anthropic", model: "old-model", maxOutputTokens: 4096 },
        },
      },
    });

    const result = await importCcSwitchProviders({
      config: existing,
      records: [claudeRecord()],
      keys: ["claude:claude-gateway-1"],
      policy: "replace",
      validate: false,
    });

    expect(result.imported).toEqual([
      { providerId: EXPECTED_ID, label: "Renamed by user", action: "updated" },
    ]);
    const provider = result.patch.providers?.filter((item) => item.id === EXPECTED_ID);
    expect(provider).toHaveLength(1);
    expect(provider?.[0]?.models.map((model) => model.id)).toContain("deepseek-v4-flash");
    // Untouched connection extras (per-provider request caps) are preserved.
    expect(result.patch.providerConnections?.[EXPECTED_ID]?.extra).toEqual(
      expect.objectContaining({ maxOutputTokens: 4096, model: "deepseek-v4-flash" }),
    );
  });

  it("detects and resolves same-endpoint conflicts", async () => {
    const existingId = "custom-api:handmade";
    const base = configWith({
      providers: [
        ...BUILTIN_PROVIDERS,
        {
          id: existingId,
          label: "Handmade gateway",
          status: "live",
          kind: "api",
          caps: { canFollowUp: true, canCancel: true },
          models: [{ id: "deepseek-v4-flash", label: "deepseek-v4-flash" }],
        },
      ],
      providerConnections: {
        [existingId]: {
          providerId: existingId,
          baseUrl: "https://Gateway.example.test/",
          apiKeyMasked: "sk-a****mnop",
          extra: { kind: "api", apiFormat: "anthropic", model: "deepseek-v4-flash" },
        },
      },
    });
    const records = [claudeRecord()];

    const preview = buildPreview(base, mapCcSwitchRecords(records).candidates);
    expect(preview[0]).toEqual(
      expect.objectContaining({ conflict: "same-endpoint", conflictProviderId: existingId }),
    );

    const skipped = await importCcSwitchProviders({
      config: base,
      records,
      keys: ["claude:claude-gateway-1"],
      validate: false,
    });
    expect(skipped.skipped[0]?.reason).toBe("已存在相同端点的供应商");

    const replaced = await importCcSwitchProviders({
      config: base,
      records,
      keys: ["claude:claude-gateway-1"],
      policy: "replace",
      validate: false,
    });
    expect(replaced.imported).toEqual([
      { providerId: existingId, label: "Handmade gateway", action: "updated" },
    ]);

    const copied = await importCcSwitchProviders({
      config: base,
      records,
      keys: ["claude:claude-gateway-1"],
      policy: "copy",
      validate: false,
    });
    expect(copied.imported).toEqual([
      { providerId: EXPECTED_ID, label: "My Gateway", action: "created" },
    ]);
    expect(copied.patch.providers?.map((item) => item.id)).toContain(existingId);
  });

  it("plans duplicate ids with a fresh id when the policy is copy", () => {
    const plan = planImport(
      configWith({
        providers: [
          ...BUILTIN_PROVIDERS,
          {
            id: EXPECTED_ID,
            label: "Existing",
            status: "live",
            kind: "api",
            caps: { canFollowUp: true, canCancel: true },
            models: [{ id: "m", label: "m" }],
          },
        ],
      }),
      mapCcSwitchRecords([claudeRecord()]).candidates,
      "copy",
    );

    expect(plan.entries[0]?.providerId).toBe(`${EXPECTED_ID}-2`);
    expect(plan.entries[0]?.action).toBe("created");
  });

  it("reports unknown keys and unselectable candidates", async () => {
    const result = await importCcSwitchProviders({
      config: configWith(),
      records: [claudeRecord()],
      keys: ["claude:claude-gateway-1", "claude:does-not-exist"],
      validate: false,
    });

    expect(result.warnings).toEqual([
      expect.stringContaining("claude:does-not-exist"),
    ]);

    const preview = buildPreview(configWith(), [
      {
        key: "claude:no-models",
        appType: "claude",
        sourceId: "no-models",
        label: "No models",
        baseUrl: "https://empty.example.test",
        apiFormat: "anthropic",
        apiKey: "sk-x",
        apiKeyMasked: "sk-x****",
        models: [],
        defaultModel: "",
        warnings: [],
      },
    ]);
    expect(preview[0]).toEqual(
      expect.objectContaining({ selectable: false, reason: "没有可用模型" }),
    );
  });
});
